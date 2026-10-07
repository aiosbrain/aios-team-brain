import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  identityLinkRequest,
  identityUnlinkRequest,
  standingRemapOffer,
  type DisplayedIdentityRow,
  type IdentityProvider,
  type IdentityRemapOffer,
} from "@/components/admin/provider-identity-link-payload";

/**
 * WHAT THE ADMIN IDENTITY ROW SENDS (AIO-1167 X-02), for every provider.
 *
 * Spec. The row displays one identity and the admin requests one; the two are never mixed:
 *   1. the displayed id travels with ITS displayed revision, as `observed.original`, whatever id is
 *      requested — and a blank row, which displays none, sends no revision at all;
 *   2. a revision for the REQUESTED id is sent only as `observed.remap`, only on the explicit
 *      "Remap" confirmation, and only for the exact id the action's offer named;
 *   3. an offer is discarded the moment a different id is requested, and typing the old id again
 *      does not bring it back;
 *   4. an UNLINK sends the displayed id bound to the row's own member AND its displayed revision —
 *      never the revision alone, never the id typed into the box — and a blank row sends nothing.
 *
 * SCOPE, stated plainly: this repository has no DOM test harness, so nothing here renders the
 * component or clicks a button. These are tests of the pure payload module the component delegates
 * to, plus a source check that the component really does delegate — every value it sends to the
 * action comes from that module. What the action then does with the payload is the real-PostgreSQL
 * suite's subject (`test/datamechanics/identity-link-observation`).
 */

const PROVIDERS: IdentityProvider[] = ["slack", "linear", "plane", "gdrive"];

/** Ids shaped as each provider's really are; the Google ones carry their verified-key prefix. No
 * digits, so a revision that leaks into a payload cannot hide inside an id. */
const ids = (provider: IdentityProvider) => provider === "gdrive"
  ? { displayed: "permission:displayed-a", requested: "subject:requested-b", other: "permission:other-c" }
  : { displayed: `${provider}-displayed-a`, requested: `${provider}-requested-b`, other: `${provider}-other-c` };

/** Deliberately different numbers, so one standing in for the other cannot go unnoticed. */
const DISPLAYED_REVISION = 7;
const TARGET_REVISION = 3;

const changeRow = (provider: IdentityProvider): DisplayedIdentityRow =>
  ({ provider, externalId: ids(provider).displayed, revision: DISPLAYED_REVISION });
const blankRow = (provider: IdentityProvider): DisplayedIdentityRow => ({ provider, externalId: null, revision: 0 });
const offerFor = (externalId: string): IdentityRemapOffer => ({ externalId, revision: TARGET_REVISION, linkedTo: "Bob" });

describe.each(PROVIDERS)("identity row payload — %s", (provider) => {
  const id = ids(provider);

  it("CHANGE to a different id: the displayed id keeps its own revision, and the requested id is sent with none", () => {
    const request = identityLinkRequest(changeRow(provider), id.requested, null, false);
    expect(request).toEqual({
      provider,
      externalId: id.requested,
      observed: { original: { externalId: id.displayed, revision: DISPLAYED_REVISION } },
    });
    // The displayed revision is attached to the displayed id and to nothing else.
    expect(request.observed.original?.externalId).not.toBe(request.externalId);
    expect("remap" in request.observed).toBe(false);
  });

  it("the requested id is trimmed; the displayed identity is sent exactly as displayed", () => {
    const request = identityLinkRequest(changeRow(provider), `  ${id.requested}\t`, null, false);
    expect(request.externalId).toBe(id.requested);
    expect(request.observed.original).toEqual({ externalId: id.displayed, revision: DISPLAYED_REVISION });
  });

  it("SAVING THE DISPLAYED ID: the request and the observation name the same identity at its displayed revision", () => {
    expect(identityLinkRequest(changeRow(provider), id.displayed, null, false)).toEqual({
      provider,
      externalId: id.displayed,
      observed: { original: { externalId: id.displayed, revision: DISPLAYED_REVISION } },
    });
  });

  it("a BLANK row has observed nothing: no original, and no revision anywhere in what it sends", () => {
    const request = identityLinkRequest(blankRow(provider), id.requested, null, false);
    expect(request).toEqual({ provider, externalId: id.requested, observed: { original: null } });
    // The blank row's placeholder revision (0) must not travel as an observation of anything.
    expect(JSON.stringify(request)).not.toContain("revision");
    // …not even when a caller hands the row a non-zero one.
    expect(JSON.stringify(identityLinkRequest({ provider, externalId: null, revision: 9 }, id.requested, null, false)))
      .not.toContain("revision");
  });

  it("an OFFER is not a confirmation: an ordinary save while an offer stands sends no target revision", () => {
    const request = identityLinkRequest(changeRow(provider), id.requested, offerFor(id.requested), false);
    expect(request.observed).toEqual({ original: { externalId: id.displayed, revision: DISPLAYED_REVISION } });
  });

  it("EXPLICIT CONFIRMATION sends the TARGET revision the offer showed — beside, never instead of, the displayed one", () => {
    const request = identityLinkRequest(changeRow(provider), id.requested, offerFor(id.requested), true);
    expect(request).toEqual({
      provider,
      externalId: id.requested,
      observed: {
        original: { externalId: id.displayed, revision: DISPLAYED_REVISION },
        remap: { revision: TARGET_REVISION },
      },
    });
    // Whitespace around the same id is the same request.
    expect(identityLinkRequest(changeRow(provider), ` ${id.requested} `, offerFor(id.requested), true).observed.remap)
      .toEqual({ revision: TARGET_REVISION });
    // From a blank row the confirmation carries the target revision and still no original.
    expect(identityLinkRequest(blankRow(provider), id.requested, offerFor(id.requested), true).observed)
      .toEqual({ original: null, remap: { revision: TARGET_REVISION } });
  });

  it("a CONFIRMATION WITHOUT A STANDING OFFER sends no target revision: no offer, or an offer for another id", () => {
    expect(identityLinkRequest(changeRow(provider), id.requested, null, true).observed)
      .toEqual({ original: { externalId: id.displayed, revision: DISPLAYED_REVISION } });
    // The offer named `requested`; the box now holds `other`. Its revision belongs to neither.
    const stale = identityLinkRequest(changeRow(provider), id.other, offerFor(id.requested), true);
    expect(stale).toEqual({
      provider,
      externalId: id.other,
      observed: { original: { externalId: id.displayed, revision: DISPLAYED_REVISION } },
    });
    expect(JSON.stringify(stale)).not.toContain(String(TARGET_REVISION));
  });

  it("an offer STANDS only for the id it named, is discarded when the requested id changes, and does not return", () => {
    const offer = offerFor(id.requested);
    expect(standingRemapOffer(offer, id.requested)).toBe(offer);
    expect(standingRemapOffer(offer, `${id.requested} `), "trailing whitespace is the same id").toBe(offer);
    expect(standingRemapOffer(offer, id.other)).toBeNull();
    expect(standingRemapOffer(offer, `${id.requested}x`)).toBeNull();
    expect(standingRemapOffer(offer, "")).toBeNull();
    expect(standingRemapOffer(null, id.requested)).toBeNull();

    // The row's own sequence: every edit of the box passes the held offer through this function.
    let held: IdentityRemapOffer | null = offer;
    for (const typed of [id.requested, id.other, id.requested]) held = standingRemapOffer(held, typed);
    expect(held, "typing the offered id again must not resurrect a discarded offer").toBeNull();
    expect(identityLinkRequest(changeRow(provider), id.requested, held, true).observed)
      .toEqual({ original: { externalId: id.displayed, revision: DISPLAYED_REVISION } });
  });
});

describe.each(PROVIDERS)("identity row UNLINK payload — %s", (provider) => {
  const id = ids(provider);
  const MEMBER = "member-alice";

  it("binds the displayed id to the row's member and its displayed revision — all three, and nothing else", () => {
    const request = identityUnlinkRequest(changeRow(provider), MEMBER);
    expect(request).toEqual({
      provider,
      externalId: id.displayed,
      observed: { memberId: MEMBER, revision: DISPLAYED_REVISION },
    });
    // The observation is never the revision alone: it always says whose link was displayed.
    expect(Object.keys(request!.observed).sort()).toEqual(["memberId", "revision"]);
  });

  it("follows the row it is given: another member's row, or another revision, is another observation", () => {
    expect(identityUnlinkRequest(changeRow(provider), "member-bob")?.observed)
      .toEqual({ memberId: "member-bob", revision: DISPLAYED_REVISION });
    expect(identityUnlinkRequest({ provider, externalId: id.displayed, revision: TARGET_REVISION }, MEMBER)?.observed)
      .toEqual({ memberId: MEMBER, revision: TARGET_REVISION });
  });

  it("a BLANK row displays no identity and so unlinks nothing", () => {
    expect(identityUnlinkRequest(blankRow(provider), MEMBER)).toBeNull();
    expect(identityUnlinkRequest({ provider, externalId: "", revision: DISPLAYED_REVISION }, MEMBER)).toBeNull();
  });
});

describe("the component delegates its payload to that module", () => {
  const ROOT = join(import.meta.dirname, "..");
  const component = readFileSync(join(ROOT, "components/admin/provider-identity-link.tsx"), "utf8");
  const panel = readFileSync(join(ROOT, "components/admin/member-identities.tsx"), "utf8");

  it("the one link call sends exactly what `identityLinkRequest` built from the row's displayed identity", () => {
    expect(component).toContain("const request = identityLinkRequest({ provider, externalId, revision }, value, remap, confirmRemap);");
    // `\b`, so the unlink action's name does not count as a second call.
    expect(component.match(/\blinkMemberIdentity\(/g), "one link call site").toHaveLength(1);
    expect(component).toContain(
      "linkMemberIdentity(teamSlug, memberId, request.provider, request.externalId, handle ?? undefined, request.observed)"
    );
  });

  it("the one unlink call sends exactly what `identityUnlinkRequest` built from the row's displayed identity and its own member", () => {
    expect(component).toContain("const request = identityUnlinkRequest({ provider, externalId, revision }, memberId);");
    expect(component.match(/\bunlinkMemberIdentity\(/g), "one unlink call site").toHaveLength(1);
    expect(component).toContain("unlinkMemberIdentity(teamSlug, request.provider, request.externalId, request.observed)");
    // The box's text is a link request only: an unlink never reads it.
    const unlink = component.slice(component.indexOf("function unlink() {"), component.indexOf("return (\n    <div"));
    expect(unlink.length, "the unlink handler must be found").toBeGreaterThan(100);
    expect(unlink).not.toMatch(/\bvalue\b/);
  });

  it("only the Remap button confirms; Save and Enter never do", () => {
    expect(component).toContain("function submit(confirmRemap = false) {");
    expect(component.match(/submit\(true\)/g), "one confirming control").toHaveLength(1);
    expect(component).toMatch(/<button onClick=\{\(\) => submit\(true\)\}[^>]*>\s*\{pending \? "…" : "Remap"\}/);
    expect(component).toMatch(/<button onClick=\{\(\) => submit\(\)\}[^>]*>\s*\{pending \? "…" : "Save"\}/);
    expect(component).toContain('if (e.key === "Enter") submit();');
    // A bare `onClick={submit}` would pass the click event as `confirmRemap`.
    expect(component).not.toMatch(/onClick=\{submit\}/);
  });

  it("every edit of the box re-evaluates the held offer, and only a standing offer is shown or confirmable", () => {
    expect(component).toContain("setRemap((standing) => standingRemapOffer(standing, requested));");
    expect(component).toContain("const offer = standingRemapOffer(remap, value);");
    expect(component).toContain("{editing && offer ? (");
    expect(component).not.toMatch(/\{editing && remap \?/);
  });

  it("the panel hands each row the displayed id TOGETHER with that id's own revision, and a blank row neither", () => {
    // Slack / Linear / Plane: both props come from the same displayed identity.
    expect(panel).toMatch(/externalId=\{providers\[p\.key\]\?\.externalId \?\? null\}[\s\S]{0,200}revision=\{providers\[p\.key\]\?\.revision \?\? 0\}/);
    // Google: one row per identity, each with its own revision…
    expect(panel).toMatch(/externalId=\{identity\.externalId\}[\s\S]{0,200}revision=\{identity\.revision\}/);
    // …and the blank "add" row displays no identity.
    expect(panel).toMatch(/externalId=\{null\}[\s\S]{0,120}revision=\{0\}/);
  });
});
