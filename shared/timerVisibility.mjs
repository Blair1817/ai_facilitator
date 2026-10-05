export const FORMAL_DISCUSSION_FORCE_TIMER_SECONDS = 180;

export function resolveTimerVisibility({
  collapsible = false,
  forceVisibleAtSeconds = null,
  remaining = null,
  manuallyVisible = false,
} = {}) {
  const forcedVisible = collapsible
    && Number.isFinite(forceVisibleAtSeconds)
    && Number.isFinite(remaining)
    && remaining <= forceVisibleAtSeconds;
  const visible = !collapsible || Boolean(manuallyVisible) || forcedVisible;
  const canToggle = collapsible && !forcedVisible;

  return {
    forcedVisible,
    visible,
    canToggle,
    controlLabel: canToggle ? (visible ? "Hide timer" : "Show timer") : null,
  };
}
