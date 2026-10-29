// AudioBridge RTP forwarder bootstrap.
//
// Janus's AudioBridge plugin can ship a room's mixed audio out as RTP via
// a "rtp_forward" plugin request. There's no way to declare forwarders
// statically in janus.plugin.audiobridge.jcfg, so we register the forwarder
// once at container startup against the live Janus WebSocket API.
//
// What this does:
//   1. Wait for ws://janus:8188 to accept connections (Janus takes ~1-2s to
//      open its listener after the container starts).
//   2. Open a session, attach the AudioBridge plugin handle.
//   3. Send {request: "rtp_forward", room, admin_key, host, port, codec}
//      so AudioBridge starts forwarding the mixed Opus stream to the Pi.
//   4. Keep the session alive (Janus garbage-collects sessions that don't
//      send keepalives every ~60s, and forwarders die with their session).
//   5. If the connection drops (Janus restart, network blip), reconnect
//      and re-register the forwarder.
//
// Required env:
//   JANUS_WS_URL          e.g. ws://janus:8188
//   AUDIOBRIDGE_ROOM      e.g. 1234
//   AUDIOBRIDGE_ADMIN_KEY must match general.admin_key in janus.plugin.audiobridge.jcfg
//   PI_TAILSCALE_IP       destination host for the forwarder (the Pi)
//   AUDIO_RX_PORT         destination port on the Pi (matches AUDIO_RX_PORT in fpv-audio-rx.service)

const JANUS_WS_URL = process.env.JANUS_WS_URL || 'ws://janus:8188';
const ROOM = Number(process.env.AUDIOBRIDGE_ROOM || '1234');
const ADMIN_KEY = process.env.AUDIOBRIDGE_ADMIN_KEY || 'changeme';
const PI_HOST = process.env.PI_TAILSCALE_IP || '';
const PI_PORT = Number(process.env.AUDIO_RX_PORT || '5008');
const KEEPALIVE_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;

if (!PI_HOST) {
    console.error('[bootstrap] FATAL: PI_TAILSCALE_IP is not set. Set it in server/.env so the AudioBridge knows where to forward audio.');
    process.exit(1);
}

const log = (...args) => console.log('[bootstrap]', ...args);
const warn = (...args) => console.warn('[bootstrap]', ...args);

function txid() {
    return Math.random().toString(36).slice(2, 14);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function runOnce() {
    log(`Connecting to Janus at ${JANUS_WS_URL}`);
    // Janus expects the "janus-protocol" subprotocol on its WebSocket.
    const ws = new WebSocket(JANUS_WS_URL, 'janus-protocol');

    const pending = new Map();
    let sessionId = 0;
    let handleId = 0;
    let keepalive;

    const send = (msg) => new Promise((resolve, reject) => {
        const tx = txid();
        pending.set(tx, (reply) => {
            if (reply.janus === 'error') {
                reject(new Error(`Janus error: ${reply.error?.reason ?? 'unknown'}`));
            } else {
                resolve(reply);
            }
        });
        ws.send(JSON.stringify({ ...msg, transaction: tx }));
        // Per-request safety timeout so a hung Janus doesn't hang us forever.
        setTimeout(() => {
            if (pending.delete(tx)) {
                reject(new Error('Janus request timed out'));
            }
        }, 10_000);
    });

    return new Promise((resolveOuter, rejectOuter) => {
        ws.addEventListener('open', () => {
            log('WebSocket open');
            (async () => {
                try {
                    const created = await send({ janus: 'create' });
                    sessionId = created.data.id;
                    log(`Session created: ${sessionId}`);

                    const attached = await send({
                        janus: 'attach',
                        session_id: sessionId,
                        plugin: 'janus.plugin.audiobridge'
                    });
                    handleId = attached.data.id;
                    log(`AudioBridge handle attached: ${handleId}`);

                    // The AudioBridge plugin auto-creates rooms declared in
                    // janus.plugin.audiobridge.jcfg, but we still need to
                    // register the RTP forwarder every time the plugin starts.
                    const forwardReply = await send({
                        janus: 'message',
                        session_id: sessionId,
                        handle_id: handleId,
                        body: {
                            request: 'rtp_forward',
                            room: ROOM,
                            admin_key: ADMIN_KEY,
                            host: PI_HOST,
                            port: PI_PORT,
                            codec: 'opus',
                            always_on: true
                        }
                    });
                    const data = forwardReply.plugindata?.data;
                    if (data?.audiobridge === 'success') {
                        log(`RTP forwarder registered: room=${ROOM} -> ${PI_HOST}:${PI_PORT} (stream_id=${data.stream_id ?? 'n/a'})`);
                    } else {
                        throw new Error(`rtp_forward failed: ${JSON.stringify(data)}`);
                    }

                    // Keep the session alive. If we let it idle out, Janus
                    // tears down our handle and silently kills the forwarder.
                    keepalive = setInterval(() => {
                        send({ janus: 'keepalive', session_id: sessionId }).catch((e) =>
                            warn('keepalive failed:', e instanceof Error ? e.message : e)
                        );
                    }, KEEPALIVE_MS);
                } catch (err) {
                    rejectOuter(err);
                    try { ws.close(); } catch { /* already closed */ }
                }
            })();
        });

        ws.addEventListener('message', (ev) => {
            const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
            let msg;
            try {
                msg = JSON.parse(raw);
            } catch {
                return;
            }
            if (msg.transaction && pending.has(msg.transaction)) {
                // Janus sometimes sends "ack" before the real reply on async
                // plugin requests; only resolve on the final event.
                if (msg.janus === 'ack') {
                    return;
                }
                const cb = pending.get(msg.transaction);
                pending.delete(msg.transaction);
                cb(msg);
            }
        });

        ws.addEventListener('close', () => {
            log('WebSocket closed');
            if (keepalive) clearInterval(keepalive);
            resolveOuter();
        });

        ws.addEventListener('error', (ev) => {
            warn('WebSocket error:', ev?.message ?? '(no message)');
            // close handler runs next and resolves the promise.
        });
    });
}

async function main() {
    log(`Bootstrapping AudioBridge forwarder: room=${ROOM} -> ${PI_HOST}:${PI_PORT}`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            await runOnce();
        } catch (err) {
            warn('Bootstrap iteration failed:', err instanceof Error ? err.message : err);
        }
        log(`Reconnecting in ${RECONNECT_DELAY_MS}ms`);
        await sleep(RECONNECT_DELAY_MS);
    }
}

main().catch((err) => {
    console.error('[bootstrap] FATAL:', err);
    process.exit(1);
});
