#!/usr/bin/env python3
"""FPV control daemon entry point.

Receives authenticated UDP control datagrams from the home server's control
relay and forwards them as binary frames to an Arduino Nano over USB-CDC
serial. The Arduino generates the actual servo/ESC PWM.

See ``fpv_control/protocol.py`` for the wire format and
``fpv_control/daemon.py`` for the event loop.
"""

from __future__ import annotations

import logging
import signal
import sys
from types import FrameType
from typing import Optional

from fpv_control.config import ConfigError, load_config
from fpv_control.daemon import ControlDaemon


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    logger = logging.getLogger("control_daemon")

    try:
        config = load_config()
    except ConfigError as exc:
        logger.error("Configuration error: %s", exc)
        return 2

    daemon = ControlDaemon(config)

    def handle_signal(signum: int, _frame: Optional[FrameType]) -> None:
        logger.info("Received signal %d", signum)
        daemon.request_stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    daemon.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
