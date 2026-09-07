import test from "node:test";
import assert from "node:assert/strict";
import { dueSlot, latestSlot, nextSlots } from "../scheduler/clock.mjs";

test("Shanghai morning and noon slots are independent of machine timezone and DST", () => {
  const initial = process.env.TZ;
  try {
    for (const zone of ["America/Los_Angeles", "UTC", "Asia/Shanghai", "Europe/London"]) {
      process.env.TZ = zone;
      for (const date of ["2026-03-08", "2026-11-01", "2026-09-07"]) {
        assert.equal(latestSlot(new Date(`${date}T01:30:00Z`)).id, `${date}-0930`);
        assert.equal(latestSlot(new Date(`${date}T04:30:00Z`)).id, `${date}-1230`);
      }
    }
  } finally {
    if (initial === undefined) delete process.env.TZ;
    else process.env.TZ = initial;
  }
});

test("only the latest missed slot is due, with no replay after restart or a failed attempt", () => {
  const state = { activatedAt: "2026-09-01T00:00:00Z", paused: false, lastScheduledSlot: "2026-09-01-0930" };
  const now = new Date("2026-09-07T11:00:00Z");
  assert.equal(dueSlot(state, now).id, "2026-09-07-1230");
  state.lastScheduledSlot = "2026-09-07-1230";
  state.lastRun = { status: "blocked" };
  assert.equal(dueSlot(JSON.parse(JSON.stringify(state)), now), null);
  assert.equal(dueSlot(state, new Date("2026-09-08T01:30:00Z")).id, "2026-09-08-0930");
});

test("activation, pause and clock rollback prevent unexpected attempts", () => {
  const now = new Date("2026-09-07T01:00:00Z");
  const state = { activatedAt: now.toISOString(), paused: false };
  assert.equal(dueSlot(state, now), null);
  assert.equal(dueSlot({ ...state, paused: true }, new Date("2026-09-07T11:00:00Z")), null);
  assert.equal(dueSlot({ ...state, lastScheduledSlot: "2026-09-08-1230" }, new Date("2026-09-07T11:00:00Z")), null);
  assert.deepEqual(nextSlots(now).map((slot) => slot.at), ["2026-09-07T01:30:00.000Z", "2026-09-07T04:30:00.000Z"]);
  assert.equal(latestSlot(now).id, "2026-09-06-1230");
});
