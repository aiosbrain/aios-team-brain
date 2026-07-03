import { describe, expect, it } from "vitest";
import { subjectMatchesMember, normName, type RosterPerson } from "@/lib/dashboard/people-match";

/**
 * Spec for folding the Learning layer's noisy person names onto the canonical roster. Derived from
 * two real data problems on the aios team: the graph has "two Johns" (a bare "John" node plus
 * "John Ellison") that must resolve to the SINGLE roster member, and the roster's own display name
 * is sometimes just a first name ("Chetan") that must still match "Chetan Nandakumar".
 */

const john: RosterPerson = { memberId: "m1", displayName: "John Ellison", handle: "john-ellison" };
const chetan: RosterPerson = { memberId: "m2", displayName: "Chetan", handle: "chetan" };

describe("normName", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normName("John-Ellison")).toBe("john ellison");
    expect(normName("  Chetan   Nandakumar ")).toBe("chetan nandakumar");
  });
});

describe("subjectMatchesMember", () => {
  it("folds the two graph 'John' nodes onto the one roster member", () => {
    expect(subjectMatchesMember("John Ellison", john)).toBe(true); // full name
    expect(subjectMatchesMember("John", john)).toBe(true); // bare first name → same person
    expect(subjectMatchesMember("john-ellison", john)).toBe(true); // handle form
  });

  it("matches a first-name-only roster display against a fuller graph name", () => {
    expect(subjectMatchesMember("Chetan", chetan)).toBe(true);
    expect(subjectMatchesMember("Chetan Nandakumar", chetan)).toBe(true);
  });

  it("does NOT collide two people who share a first name but differ by surname", () => {
    expect(subjectMatchesMember("John Smith", john)).toBe(false);
    expect(subjectMatchesMember("John Ellison", chetan)).toBe(false);
  });

  it("returns false for empty / unrelated subjects", () => {
    expect(subjectMatchesMember("", john)).toBe(false);
    expect(subjectMatchesMember("AIOS", john)).toBe(false);
    expect(subjectMatchesMember("Priya", chetan)).toBe(false);
  });
});
