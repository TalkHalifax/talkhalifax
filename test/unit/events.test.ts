import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { checkEvents, events, ingestEvents, type LibraryEvent } from "../../src/events";
import { env } from "./helpers";

const e = { ...env, EVENTS_TOKEN: "right" } as Env;
const soon = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
const item = (id: string, start: string) => `<item><title><![CDATA[Story Time &amp; Songs]]></title><link>https://halifax.bibliocommons.com/events/${id}</link>
  <bc:start_date>${start}</bc:start_date><category>Kids</category><category>Music</category><description>Come along.<hr>Ages 3+</description>
  <bc:location><bc:name>Central Library</bc:name><bc:city>Halifax</bc:city></bc:location></item>`;
const post = (body: unknown, token = "right") => ingestEvents(new Request("https://site/api/events/ingest", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}), e);
const good = { from: "2026-11-05", to: "2026-11-19", pages: [`<rss>${item("a", soon)}${item("b", past)}${item("a", soon)}</rss>`] };
// One upcoming item with the details under test; control items use a neutral type (Crafts) so nothing is a highlight
const rich = (id: string, o: { title?: string; link?: string; cats?: string[]; desc?: string; place?: string; extra?: string } = {}) =>
  `<item><title>${o.title ?? `Event ${id}`}</title><link>${o.link ?? `https://halifax.bibliocommons.com/events/${id}`}</link>
  <bc:start_date>${soon}</bc:start_date>${(o.cats ?? ["Kids", "Crafts"]).map(c => `<category>${c}</category>`).join("")}
  <description>${o.desc ?? "Come along."}</description>
  <bc:location><bc:name>${o.place ?? "Central Library"}</bc:name><bc:city>Halifax</bc:city></bc:location>${o.extra ?? ""}</item>`;
const ingestRich = async (...items: string[]) => {
  expect((await post({ from: "2026-11-05", to: "2026-11-19", pages: [`<rss>${items.join("")}</rss>`] })).status).toBe(200);
  const res = await events(env);
  expect(res.status).toBe(200);
  const list = (await res.json<{ events: LibraryEvent[] }>()).events;
  return (id: string) => {
    const found = list.find(x => x.id === id);
    if (!found) throw new Error(`event ${id} not listed`);
    return found;
  };
};

describe("library events from the GitHub Action", () => {
  it("need the token", async () => {
    expect((await post(good, "wrong")).status).toBe(401);
    expect((await ingestEvents(new Request("https://site/x", { method: "POST", body: "{}" }), env)).status).toBe(401);
  });
  it("are parsed as the library lists them: no repeats, nothing already over", async () => {
    expect(await (await post(good)).json()).toMatchObject({ events: 1 });
    const d = await (await events(env)).json<{ events: unknown[] }>();
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ id: "a", title: "Story Time & Songs", place: "Central Library", audiences: ["Kids"], highlight: true, summary: "Come along." });
  });
  it("keep the last good list when a run comes back empty or malformed", async () => {
    await post(good);
    expect((await post({ ...good, pages: ["<rss></rss>"] })).status).toBe(422);
    expect((await post({ from: "soon", to: "later", pages: ["<rss>"] })).status).toBe(400);
    expect((await post({ ...good, pages: Array(41).fill("x") })).status).toBe(400);
    expect((await (await events(env)).json<{ events: unknown[] }>()).events).toHaveLength(1);
  });
  it("say so when none have arrived yet", async () => {
    expect((await events(env)).status).toBe(503);
  });
  it("warn the editor through the cron when they stop arriving", async () => {
    await expect(checkEvents(env)).rejects.toThrow(/never arrived/);
    await post(good);
    await expect(checkEvents(env)).resolves.toBeUndefined();
    await env.DB.prepare("UPDATE feeds SET updated_at = ? WHERE name = 'events'").bind(new Date(Date.now() - 27 * 36e5).toISOString()).run();
    await expect(checkEvents(env)).rejects.toThrow(/haven't arrived/);
  });
});

describe("library event details", () => {
  it("keep a cancelled event listed and mark it cancelled", async () => {
    const get = await ingestRich(rich("c", { extra: "<bc:is_cancelled>true</bc:is_cancelled>" }), rich("n"));
    expect(get("c").cancelled).toBe(true);
    expect(get("n").cancelled).toBe(false);
  });
  it("say when registration is required, and null when there is no registration info", async () => {
    const get = await ingestRich(rich("r", { extra: "<bc:registration_info><bc:is_required>true</bc:is_required></bc:registration_info>" }), rich("n"));
    expect(get("r").registration).toBe("required");
    expect(get("n").registration).toBeNull();
  });
  it("say full when registration is full, even when it is also required", async () => {
    const get = await ingestRich(rich("f", { extra: "<bc:registration_info><bc:is_required>true</bc:is_required><bc:is_full>true</bc:is_full></bc:registration_info>" }));
    expect(get("f").registration).toBe("full");
  });
  it("mark online events as virtual", async () => {
    const get = await ingestRich(rich("v", { extra: "<bc:is_virtual>true</bc:is_virtual>" }), rich("n"));
    expect(get("v").virtual).toBe(true);
    expect(get("n").virtual).toBe(false);
  });
  it("make featured events highlights, whether featured overall or at their location", async () => {
    const get = await ingestRich(
      rich("f", { extra: "<bc:is_featured>true</bc:is_featured>" }),
      rich("l", { extra: "<bc:is_featured_at_location>true</bc:is_featured_at_location>" }),
      rich("n"),
    );
    expect(get("f")).toMatchObject({ featured: true, highlight: true });
    expect(get("l")).toMatchObject({ featured: true, highlight: true });
    expect(get("n")).toMatchObject({ featured: false, highlight: false });
  });
  it("drop the library's stock banners but keep real pictures", async () => {
    const get = await ingestRich(
      rich("s1", { extra: `<enclosure url="https://halifax.bibliocommons.com/images/Biblio-Events-V2-Kids.png" type="image/png" length="0"/>` }),
      rich("s2", { extra: `<enclosure url="https://halifax.bibliocommons.com/images/storytime-events-1200x628.jpg" type="image/jpeg" length="0"/>` }),
      rich("p", { extra: `<enclosure url="https://halifax.bibliocommons.com/uploads/photo.jpg" type="image/jpeg" length="0"/>` }),
    );
    expect(get("s1").image).toBeNull();
    expect(get("s2").image).toBeNull();
    expect(get("p").image).toBe("https://halifax.bibliocommons.com/uploads/photo.jpg");
  });
  it("turn http links and pictures into https, taking the id from the last path segment", async () => {
    const get = await ingestRich(rich("h", {
      link: "http://halifax.bibliocommons.com/events/h",
      extra: `<enclosure url="http://halifax.bibliocommons.com/uploads/photo.jpg" type="image/jpeg" length="0"/>`,
    }));
    expect(get("h")).toMatchObject({ id: "h", url: "https://halifax.bibliocommons.com/events/h", image: "https://halifax.bibliocommons.com/uploads/photo.jpg" });
  });
  it("cut summaries over 280 characters at a word, with an ellipsis", async () => {
    const get = await ingestRich(
      rich("a", { desc: "x".repeat(280) }),
      rich("b", { desc: "x".repeat(275) + " " + "longword".repeat(3) }),
      rich("c", { desc: "abcd ".repeat(70) }),
    );
    expect(get("a").summary).toBe("x".repeat(280));
    expect(get("a").summary).not.toContain("…");
    expect(get("b").summary).toBe("x".repeat(275) + "…");
    expect(get("c").summary).toBe(Array(56).fill("abcd").join(" ") + "…");
    for (const id of ["b", "c"]) expect(get(id).summary.slice(0, -1).length).toBeLessThanOrEqual(280);
  });
  it("keep a word that ends exactly at character 280, and cut hard when there is no space", async () => {
    // The full plain text of each cut item, after tags, entities and whitespace are dealt with
    const plain: Record<string, string> = {
      end: "x".repeat(275) + " abcd more text",
      sp: "x".repeat(279) + " " + "y".repeat(30),
      hard: "x".repeat(300),
      hardsp: "x".repeat(280) + " tail",
      one: "a " + "x".repeat(300),
      ent: "x".repeat(274) + " &&&&& tail",
      tags: "x".repeat(275) + " abcd more",
    };
    const get = await ingestRich(
      rich("end", { desc: plain.end }),
      rich("sp", { desc: plain.sp }),
      rich("hard", { desc: plain.hard }),
      rich("hardsp", { desc: plain.hardsp }),
      rich("one", { desc: plain.one }),
      rich("short", { desc: "x".repeat(279) }),
      rich("ent", { desc: "x".repeat(274) + " &amp;&amp;&amp;&amp;&amp; tail" }),
      rich("tags", { desc: `<![CDATA[${"x".repeat(275)}\n\n  <br>abcd   more]]>` }),
    );
    expect(get("end").summary, "end").toBe("x".repeat(275) + " abcd…");
    expect(get("sp").summary, "sp").toBe("x".repeat(279) + "…");
    expect(get("hard").summary, "hard").toBe("x".repeat(280) + "…");
    expect(get("hardsp").summary, "hardsp").toBe("x".repeat(280) + "…");
    expect(get("one").summary, "one").toBe("a…");
    expect(get("short").summary, "short").toBe("x".repeat(279));
    expect(get("short").summary, "short").not.toContain("…");
    expect(get("ent").summary, "ent").toBe("x".repeat(274) + " &&&&&…");
    expect(get("tags").summary, "tags").toBe("x".repeat(275) + " abcd…");
    for (const id of Object.keys(plain)) {
      const s = get(id).summary, head = s.slice(0, -1);
      expect(s.endsWith("…"), id).toBe(true);
      expect(head.endsWith("…"), id).toBe(false);
      expect(head.length, id).toBeGreaterThanOrEqual(1);
      expect(head.length, id).toBeLessThanOrEqual(280);
      expect(head.endsWith(" "), id).toBe(false);
      expect(plain[id].startsWith(head), id).toBe(true);
    }
  });
  it("keep only the text before the first rule in the summary", async () => {
    const get = await ingestRich(
      rich("a", { desc: "<![CDATA[<p>Join us.</p><hr><p>Ages 3+</p>]]>" }),
      rich("b", { desc: "<![CDATA[<p>Join us.</p><hr/><p>Ages 3+</p>]]>" }),
      rich("c", { desc: "<![CDATA[<p>Join us.</p><HR /><p>Ages 3+</p>]]>" }),
      rich("d", { desc: "<![CDATA[A<hr>B<hr>C]]>" }),
    );
    for (const id of ["a", "b", "c"]) expect(get(id).summary).toBe("Join us.");
    expect(get("d").summary).toBe("A");
  });
  it("decode HTML entities in the title, place and summary, once, leaving unknown ones as written", async () => {
    const get = await ingestRich(
      rich("t", { title: "Caf&#233; &amp; Crafts &#x2014; Kids&rsquo; Night" }),
      rich("u", { title: "Fun &foo; Day" }),
      rich("o", { title: "Less &amp;lt; More" }),
      rich("p", { place: "Alderney Gate &amp; Ferry" }),
      rich("s", { desc: "<![CDATA[<p>Join &nbsp;us &nbsp; today.</p>]]>" }),
    );
    expect(get("t").title).toBe("Café & Crafts — Kids’ Night");
    expect(get("u").title).toBe("Fun &foo; Day");
    expect(get("o").title).toBe("Less &lt; More");
    expect(get("p").place).toBe("Alderney Gate & Ferry");
    expect(get("s").summary).toBe("Join us today.");
  });
  it("leave language categories out of types and audiences", async () => {
    const get = await ingestRich(rich("l", { cats: ["Kids", "Crafts", "French", "arabic", "ASL", "Mi&#39;kmaw", "English"] }));
    expect(get("l").types).toEqual(["Crafts"]);
    expect(get("l").audiences).toEqual(["Kids"]);
  });
  it("store an event whose title has an out-of-range numeric entity, leaving the entity as written", async () => {
    const get = await ingestRich(
      rich("d", { title: "Big &#1114112; Night" }),
      rich("x", { title: "Big &#x110000; Night" }),
    );
    expect(get("d").title).toBe("Big &#1114112; Night");
    expect(get("x").title).toBe("Big &#x110000; Night");
  });
});
