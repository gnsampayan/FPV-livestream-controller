import { useCallback, useId, useState } from 'react';
import type { ReactNode } from 'react';

interface CollapsiblePanelProps {
    title: string;
    /**
     * Whether the feature behind this panel is currently usable. While
     * inactive the panel collapses by default and its content is rendered
     * disabled (dimmed, non-interactive) if the user chooses to expand it.
     */
    active: boolean;
    /** Short badge shown in the header while inactive (e.g. "PI OFFLINE"). */
    inactiveLabel?: string;
    /**
     * Keep children mounted (just hidden) while collapsed. Needed for content
     * that owns global behaviour, such as the push-to-talk spacebar listener.
     * Leave off for layout-sensitive content such as joysticks.
     */
    keepMounted?: boolean;
    children: ReactNode;
}

/**
 * A user choice about expansion, remembered only for the `active` state it was
 * made in. When `active` changes the choice is ignored, so the panel snaps back
 * to its default (expanded when active, collapsed when inactive).
 */
interface ExpansionOverride {
    forActive: boolean;
    expanded: boolean;
}

export function CollapsiblePanel({
    title,
    active,
    inactiveLabel = 'OFFLINE',
    keepMounted = false,
    children
}: CollapsiblePanelProps) {
    const contentId = useId();
    const [override, setOverride] = useState<ExpansionOverride | null>(null);

    const expanded = override !== null && override.forActive === active ? override.expanded : active;

    const toggle = useCallback(() => {
        setOverride({ forActive: active, expanded: !expanded });
    }, [active, expanded]);

    return (
        <div className="panel">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={expanded}
                aria-controls={contentId}
                className={`panel-header w-full flex items-center justify-between gap-2 text-left transition-colors hover:bg-fpv-panel ${
                    expanded ? '' : 'border-b-0'
                }`}
            >
                <span className="flex items-center gap-2">
                    <span aria-hidden="true" className="inline-block w-3 text-gray-500">
                        {expanded ? '▾' : '▸'}
                    </span>
                    <span className={active ? '' : 'text-gray-500'}>{title}</span>
                </span>
                {!active && (
                    <span className="px-1.5 py-0.5 border border-fpv-border rounded text-[9px] tracking-wider text-gray-500">
                        {inactiveLabel}
                    </span>
                )}
            </button>

            {(expanded || keepMounted) && (
                <div
                    id={contentId}
                    hidden={!expanded}
                    aria-disabled={!active}
                    className={active ? '' : 'opacity-40 pointer-events-none select-none'}
                >
                    {children}
                </div>
            )}
        </div>
    );
}
