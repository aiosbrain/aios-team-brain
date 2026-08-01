import { describe, expect, it } from "vitest";
import { decisionActors, subjectMatchesMember, normName, type RosterPerson } from "@/lib/dashboard/people-match";

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

/**
 * Spec: a decision belongs in the day of EVERY person who made it.
 *
 * The timeline used to drop any `decided_by` that wasn't exactly one name. On prod that was 27 of 56
 * decisions — 48% — and the shape it hid was the worst possible one: the calls two people made together
 * ("John Ellison & Chetan") vanished, while solo ones stayed. Fixtures below mirror the shapes of the real prod strings (all names synthetic).
 */
describe("decisionActors", () => {
  const roster: RosterPerson[] = [
    { memberId: "m-john", displayName: "John Ellison", handle: "john-ellison" },
    { memberId: "m-chetan", displayName: "Chetan", handle: "chetan" },
    { memberId: "m-ada", displayName: "Ada Sample", handle: "ada" },
  ];

  it("credits BOTH people in a joint decision", () => {
    expect(decisionActors("John Ellison & Chetan", roster)).toEqual(["m-john", "m-chetan"]);
    expect(decisionActors("John Ellison & Ada Sample", roster)).toEqual(["m-john", "m-ada"]);
  });

  it("credits the decider AND the agreer in a qualified attribution", () => {
    expect(decisionActors("John Ellison (agreed by Chetan)", roster)).toEqual(["m-john", "m-chetan"]);
    expect(decisionActors("Chetan (agreed by John)", roster)).toEqual(["m-chetan", "m-john"]);
  });

  it("keeps the decider when the qualifier names a non-member (an AI agent)", () => {
    expect(decisionActors("John Ellison (fix by Fable)", roster)).toEqual(["m-john"]);
    expect(
      decisionActors("John Ellison (fix by Fable, prompted by John flagging the send error)", roster)
    ).toEqual(["m-john"]);
  });

  it("still handles the simple single-name case", () => {
    expect(decisionActors("Chetan", roster)).toEqual(["m-chetan"]);
  });

  it("orders by mention, so the first is the primary decider", () => {
    expect(decisionActors("Chetan & John Ellison", roster)[0]).toBe("m-chetan");
  });

  it("contributes NOTHING for an unknown party or an empty string — never a guess", () => {
    expect(decisionActors("Abdul Bahri", roster)).toEqual([]);
    expect(decisionActors("", roster)).toEqual([]);
    expect(decisionActors("the team", roster)).toEqual([]);
  });

  it("never credits the same person twice", () => {
    expect(decisionActors("John Ellison and John Ellison", roster)).toEqual(["m-john"]);
  });
});
