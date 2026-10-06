import { describe, expect, it } from "vitest";
import { usSession } from "../src/session.js";

describe("usSession (New York time)", () => {
  it("labels sessions", () => {
    expect(usSession(new Date("2026-10-07T15:00:00Z"))).toBe("regular"); // Wed 11:00 EDT
    expect(usSession(new Date("2026-10-07T12:00:00Z"))).toBe("pre"); // 08:00
    expect(usSession(new Date("2026-10-07T21:00:00Z"))).toBe("post"); // 17:00
    expect(usSession(new Date("2026-10-08T03:00:00Z"))).toBe("overnight"); // Wed 23:00
    expect(usSession(new Date("2026-10-10T15:00:00Z"))).toBe("weekend"); // Sat
  });
  it("spring-forward (2026-03-08): the open moves from 14:30Z to 13:30Z", () => {
    expect(usSession(new Date("2026-03-06T14:30:00Z"))).toBe("regular"); // Fri 09:30 EST
    expect(usSession(new Date("2026-03-06T14:29:00Z"))).toBe("pre"); // Fri 09:29 EST
    expect(usSession(new Date("2026-03-09T13:30:00Z"))).toBe("regular"); // Mon 09:30 EDT
    expect(usSession(new Date("2026-03-09T13:29:00Z"))).toBe("pre"); // Mon 09:29 EDT
    expect(usSession(new Date("2026-03-08T07:30:00Z"))).toBe("weekend"); // Sun 03:30 EDT, just after the jump
  });
  it("fall-back (2026-11-01): the open moves from 13:30Z to 14:30Z", () => {
    expect(usSession(new Date("2026-10-30T13:30:00Z"))).toBe("regular"); // Fri 09:30 EDT
    expect(usSession(new Date("2026-11-02T13:30:00Z"))).toBe("pre"); // Mon 08:30 EST
    expect(usSession(new Date("2026-11-02T14:30:00Z"))).toBe("regular"); // Mon 09:30 EST
    expect(usSession(new Date("2026-11-01T05:30:00Z"))).toBe("weekend"); // Sun 01:30 EDT (first pass)
    expect(usSession(new Date("2026-11-01T06:30:00Z"))).toBe("weekend"); // Sun 01:30 EST (second pass)
  });
  it("weekend edges", () => {
    expect(usSession(new Date("2026-10-09T23:59:00Z"))).toBe("post"); // Fri 19:59 EDT
    expect(usSession(new Date("2026-10-10T00:00:00Z"))).toBe("weekend"); // Fri 20:00 EDT
    expect(usSession(new Date("2026-10-11T23:59:00Z"))).toBe("weekend"); // Sun 19:59 EDT
    expect(usSession(new Date("2026-10-12T00:00:00Z"))).toBe("overnight"); // Sun 20:00 EDT
    expect(usSession(new Date("2026-10-12T04:00:00Z"))).toBe("overnight"); // Mon 00:00 EDT
    expect(usSession(new Date("2026-12-07T05:00:00Z"))).toBe("overnight"); // Mon 00:00 EST
    expect(usSession(new Date("2026-10-12T08:00:00Z"))).toBe("pre"); // Mon 04:00 EDT
  });
});
