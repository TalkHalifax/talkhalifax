import { describe, expect, it } from "vitest";
import { checkTransitSchedule, scheduleProblem } from "../../src/transit";

const on = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("the Transit schedule check", () => {
  it("is quiet while the schedule runs, up to the day before its last: the daily job brings the next one", () => {
    expect(scheduleProblem("20261129", on("2026-11-06"))).toBeNull();
    expect(scheduleProblem("20261129", on("2026-11-22"))).toBeNull();
    expect(scheduleProblem("20261129", on("2026-11-28"))).toBeNull();
    // 11:30 pm in Halifax the day before is already Nov. 29 in UTC
    expect(scheduleProblem("20261129", new Date("2026-11-29T03:30:00Z"))).toBeNull();
  });
  it("warns on the last day, in Halifax time, as a backstop", () => {
    expect(scheduleProblem("20261129", new Date("2026-11-29T04:30:00Z"))).toMatch(/ends today, 2026-11-29/);
    expect(scheduleProblem("20261129", new Date("2026-11-30T03:30:00Z"))).toMatch(/ends today, 2026-11-29/);
  });
  it("warns once the schedule has ended", () => {
    expect(scheduleProblem("20261129", new Date("2026-11-30T04:30:00Z"))).toMatch(/ended 2026-11-29/);
    expect(scheduleProblem("20261129", on("2026-12-01"))).toMatch(/ended 2026-11-29/);
  });
  it("warns when the date can't be read", () => {
    expect(scheduleProblem("", on("2026-11-06"))).toMatch(/no end date/);
  });
  it("names what to do: the issue first, then the workflow", () => {
    const msg = scheduleProblem("20261129", on("2026-12-01"))!;
    expect(msg).toMatch(/New Transit schedule" issue/);
    expect(msg).toMatch(/Transit schedule workflow/);
  });
  it("stays well under the 300 characters the cron's alert keeps", () => {
    expect(scheduleProblem("20261129", on("2026-11-29"))!.length).toBeLessThan(270);
    expect(scheduleProblem("20261129", on("2026-12-01"))!.length).toBeLessThan(270);
  });
  it("throws for the cron, so the editor hears", () => {
    expect(() => checkTransitSchedule(on("2030-01-01"))).toThrow(/Transit/);
  });
});
