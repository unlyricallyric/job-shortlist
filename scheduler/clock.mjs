const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export const schedule = Object.freeze({ timeZone: "Asia/Shanghai", times: ["09:30", "12:30"] });

export function shanghaiParts(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid scheduler clock.");
  return Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
}

function slotsNear(now) {
  const parts = shanghaiParts(now);
  const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 8 * 60 * 60 * 1000;
  return [-1, 0, 1].flatMap((offset) => schedule.times.map((time) => {
    const [hour, minute] = time.split(":").map(Number);
    const instant = new Date(midnight + offset * 86400000 + hour * 3600000 + minute * 60000);
    const date = shanghaiParts(instant);
    return { id: `${date.year}-${date.month}-${date.day}-${time.replace(":", "")}`, time, at: instant.toISOString() };
  }));
}

export function latestSlot(now = new Date()) {
  return slotsNear(now).filter((slot) => Date.parse(slot.at) <= now.getTime()).at(-1);
}

export function nextSlots(now = new Date()) {
  return slotsNear(now).filter((slot) => Date.parse(slot.at) > now.getTime()).slice(0, 2);
}

export function dueSlot(state, now = new Date()) {
  if (state.paused) return null;
  const latest = latestSlot(now);
  if (Date.parse(latest.at) < Date.parse(state.collectionActivatedAt ?? state.activatedAt)) return null;
  if (state.lastScheduledSlot && latest.id <= state.lastScheduledSlot) return null;
  return latest;
}

export function activateNextSlot(state, now = new Date()) {
  return { ...state, collectionActivatedAt: nextSlots(now)[0].at };
}
