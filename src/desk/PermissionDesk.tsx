import { useEffect, useMemo, useRef, useState } from "react";

type ProjectKind = "rom-hack" | "gen1recomp" | "gen2recomp";
type Status = "draft" | "sent" | "follow-up" | "granted" | "denied" | "unclear";
type Assessment = "not-checked" | "likely-granted" | "likely-denied" | "unclear";
type QueueFilter = "all" | "open" | "granted" | "blocked";
type ContactType = "github-issue" | "discord" | "email";
type OutreachPurpose = "permission" | "license-packaging";

type PermissionScope = {
  mirrorFile: boolean;
  redistributeFree: boolean;
  useCreatorImages: boolean;
  useOwnCaptures: boolean;
};

type PermissionRequest = {
  id: string;
  targetKey: string;
  projectName: string;
  creatorName: string;
  creatorEmail: string;
  contactType: ContactType;
  contactLabel: string;
  contactUrl: string;
  projectUrl: string;
  releaseUrl: string;
  kind: ProjectKind;
  outreachPurpose: OutreachPurpose;
  includedProjects: string[];
  status: Status;
  subject: string;
  message: string;
  reply: string;
  assessment: Assessment;
  scope: PermissionScope;
  restrictions: string;
  evidenceUrl: string;
  createdAt: string;
  sentAt: string;
  repliedAt: string;
  notes: string;
};

const STORAGE_KEY = "phosphor-permission-desk-v1";

const statusMeta: Record<Status, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "neutral" },
  sent: { label: "Awaiting reply", tone: "amber" },
  "follow-up": { label: "Follow up", tone: "amber" },
  granted: { label: "Permission granted", tone: "green" },
  denied: { label: "Do not use", tone: "red" },
  unclear: { label: "Needs clarification", tone: "amber" },
};

const kindLabels: Record<ProjectKind, string> = {
  "rom-hack": "ROM hack patch",
  gen1recomp: "Gen 1 recomp mod",
  gen2recomp: "Gen 2 recomp mod",
};

const contactTypeLabels: Record<ContactType, string> = {
  "github-issue": "GitHub issue",
  discord: "Official Discord",
  email: "Public email",
};

function buildSubject(record: Pick<PermissionRequest, "projectName" | "outreachPurpose">) {
  const title = record.projectName || "your project";
  return record.outreachPurpose === "license-packaging"
    ? `License packaging request for ${title}`
    : `Phosphor app distribution permission for ${title}`;
}

function buildMessage(record: Pick<PermissionRequest, "creatorName" | "projectName" | "projectUrl" | "releaseUrl" | "kind" | "outreachPurpose" | "includedProjects">) {
  const title = record.projectName || "your project";
  const creator = record.creatorName || "there";
  const source = record.releaseUrl || record.projectUrl || "[release link]";
  const projectLink = record.projectUrl || "[project page]";
  const includedProjects = record.includedProjects ?? [];
  const projects = includedProjects.length ? includedProjects : [title];
  const artifactList = projects.map((project) => `• ${project}`).join("\n");

  if (record.outreachPurpose === "license-packaging") {
    return `Hi ${creator},

I'm Colson, and I'm building Phosphor Index: the free, non-commercial catalog and in-app mod browser for the Phosphor Pokémon recomp emulator.

I'm contacting you about:
${artifactList}

The source repository is published under the MIT license, but the downloadable release archive we checked does not appear to carry the license text. Our catalog pipeline needs the permission terms to travel with the file before we can offer it inside Phosphor.

Would you be willing to either:
• include the MIT LICENSE file in the next downloadable release archive; or
• confirm that Phosphor Index may mirror the unmodified release with the repository's MIT license text packaged alongside it?

Official project page: ${projectLink}
Release checked: ${source}

We would keep the download free, credit you, link to the official project, publish a checksum, and never include a commercial game ROM.

If the archive already includes the license and our check missed it, please point me to the correct release and I'll update our record.

Thank you,
Colson
Phosphor Index`;
  }

  return `Hi ${creator},

I'm Colson, and I'm building Phosphor Index: the free, non-commercial catalog and in-app mod browser for the Phosphor Pokémon emulator.

I'm requesting permission for:
${artifactList}

May Phosphor Index and the Phosphor app mirror and freely redistribute the unmodified ${kindLabels[record.kind]} release from:
${source}

We would:
• host only the patch or mod archive, never a commercial game ROM;
• make the exact, unmodified download available free on the site and inside the Phosphor app;
• credit you and link to ${projectLink};
• publish a checksum and keep your permission response as our record; and
• remove the file promptly if you later withdraw permission.

If that is okay, please reply with this statement (or equivalent wording):

“I give Phosphor Index and the Phosphor app permission to mirror and freely redistribute the unmodified patch/mod archive(s) listed above, with credit and a link to the official project page.”

Please also tell me whether we may use your published screenshots or artwork. If you prefer any limits or attribution wording, I’ll record and follow them.

Thank you,
Colson
Phosphor Index`;
}

function makeRequest(seed?: Partial<PermissionRequest>): PermissionRequest {
  const base = {
    id: crypto.randomUUID(),
    targetKey: "",
    projectName: "",
    creatorName: "",
    creatorEmail: "",
    contactType: "email" as ContactType,
    contactLabel: "Public email",
    contactUrl: "",
    projectUrl: "",
    releaseUrl: "",
    kind: "rom-hack" as ProjectKind,
    outreachPurpose: "permission" as OutreachPurpose,
    includedProjects: [] as string[],
    status: "draft" as Status,
    reply: "",
    assessment: "not-checked" as Assessment,
    scope: {
      mirrorFile: false,
      redistributeFree: false,
      useCreatorImages: false,
      useOwnCaptures: false,
    },
    restrictions: "",
    evidenceUrl: "",
    createdAt: new Date().toISOString(),
    sentAt: "",
    repliedAt: "",
    notes: "",
  };
  const merged = { ...base, ...seed, scope: { ...base.scope, ...seed?.scope } };
  return {
    ...merged,
    subject: seed?.subject ?? buildSubject(merged),
    message: seed?.message ?? buildMessage(merged),
  };
}

type CuratedTarget = Partial<PermissionRequest> & Pick<PermissionRequest, "targetKey" | "projectName" | "creatorName" | "projectUrl" | "releaseUrl" | "kind" | "contactType" | "contactLabel" | "contactUrl" | "outreachPurpose" | "includedProjects">;

function githubTarget(
  targetKey: string,
  projectName: string,
  creatorName: string,
  repository: string,
  kind: ProjectKind,
  includedProjects: string[],
  outreachPurpose: OutreachPurpose = "permission",
  notes = "Official public GitHub issue channel preloaded. Review the message, press GO, then confirm the final post on GitHub.",
): CuratedTarget {
  const projectUrl = `https://github.com/${repository}`;
  return {
    targetKey,
    id: `curated-${targetKey}`,
    projectName,
    creatorName,
    projectUrl,
    releaseUrl: `${projectUrl}/releases`,
    kind,
    includedProjects,
    outreachPurpose,
    contactType: "github-issue",
    contactLabel: `GitHub · ${repository}`,
    contactUrl: `${projectUrl}/issues/new`,
    notes,
  };
}

const CURATED_TARGETS: CuratedTarget[] = [
  githubTarget("polished-crystal", "Pokémon Polished Crystal", "Rangi", "Rangi42/polishedcrystal", "rom-hack", ["Pokémon Polished Crystal"]),
  githubTarget("solus-rgb", "Pokémon Solus RGB", "Derek Andersen / Dechrissen", "Dechrissen/poke-solus-rgb", "rom-hack", ["Pokémon Solus RGB"]),
  githubTarget("pure-rgb", "Pokémon PureRGB", "Vortyne", "Vortyne/pureRGB", "rom-hack", ["Pokémon PureRGB"]),
  {
    targetKey: "heart-and-soul",
    id: "curated-heart-and-soul",
    projectName: "Pokémon Heart & Soul",
    creatorName: "Heart & Soul Development",
    projectUrl: "https://github.com/PokemonHnS-Development/pokemonHnS",
    releaseUrl: "https://github.com/PokemonHnS-Development/pokemonHnS/releases",
    kind: "rom-hack",
    includedProjects: ["Pokémon Heart & Soul"],
    outreachPurpose: "permission",
    contactType: "discord",
    contactLabel: "Official Heart & Soul Discord",
    contactUrl: "https://discord.gg/KmuvXJrS9M",
    notes: "The repository does not accept GitHub issues. GO copies the request and opens the official Discord linked by the project.",
  },
  githubTarget("crossroads", "Pokémon Crossroads", "Crossroads Dev Team", "eonlynx/pokecrossroads", "rom-hack", ["Pokémon Crossroads"]),
  githubTarget("shin-pokemon", "Shin Pokémon Red / Blue / Green", "Shin Pokémon Project", "jojobear13/shinpokered", "rom-hack", ["Shin Pokémon Red / Blue / Green"]),
  githubTarget("pokemon-orange", "Pokémon Orange", "PiaCarrot and contributors", "PiaCarrot/pokeorange", "rom-hack", ["Pokémon Orange"]),
  githubTarget("pokemon-coral", "Pokémon Coral", "Coral Development Team", "pkmncoraldev/polishedcoral", "rom-hack", ["Pokémon Coral"]),
  githubTarget("crystal-legacy", "Pokémon Crystal Legacy", "TheSmithPlays / cRz Shadows", "cRz-Shadows/Pokemon_Crystal_Legacy", "rom-hack", ["Pokémon Crystal Legacy"]),
  githubTarget("yellow-legacy", "Pokémon Yellow Legacy", "TheSmithPlays / cRz Shadows", "cRz-Shadows/Pokemon_Yellow_Legacy", "rom-hack", ["Pokémon Yellow Legacy"]),
  {
    targetKey: "kanto-expansion-pak",
    id: "curated-kanto-expansion-pak",
    projectName: "Kanto Expansion Pak",
    creatorName: "MementoMartha and contributors",
    projectUrl: "https://github.com/MementoMartha/kep-hack",
    releaseUrl: "https://github.com/MementoMartha/kep-hack/releases",
    kind: "rom-hack",
    includedProjects: ["Kanto Expansion Pak"],
    outreachPurpose: "permission",
    contactType: "discord",
    contactLabel: "pret Discord · @memento_martha",
    contactUrl: "https://discord.gg/d5dubZ3",
    notes: "GitHub issues are disabled. GO copies the request and opens the official Discord identified by the project README.",
  },
  githubTarget("johto-expansion-pak", "Johto Expansion Pak", "MementoMartha and contributors", "MementoMartha/jep-hack", "rom-hack", ["Johto Expansion Pak"]),
  githubTarget("redstar-bluestar", "Pokémon Redstar & Bluestar", "Rangi", "Rangi42/redstarbluestar", "rom-hack", ["Pokémon Redstar & Bluestar"]),
  githubTarget("yellow-kaizo", "Pokémon Yellow Kaizo", "CreamElDudJafar and contributors", "CreamElDudJafar/Yellow-Kaizo", "rom-hack", ["Pokémon Yellow Kaizo"]),
  {
    targetKey: "static-yellow",
    id: "curated-static-yellow",
    projectName: "Static Yellow",
    creatorName: "CreamElDudJafar and contributors",
    projectUrl: "https://github.com/CreamElDudJafar/StaticYellow",
    releaseUrl: "https://github.com/CreamElDudJafar/StaticYellow/releases",
    kind: "rom-hack",
    includedProjects: ["Static Yellow"],
    outreachPurpose: "permission",
    contactType: "discord",
    contactLabel: "Official CreamElDudJafar Discord",
    contactUrl: "https://discord.gg/GFpKsrjxJs",
    notes: "GitHub issues are disabled. GO copies the request and opens the official Discord linked by the project README.",
  },
  githubTarget(
    "harry-gen1-collection",
    "Harry's Gen1Recomp mod collection",
    "Harry",
    "harryw4444/green_sgb_palette_gen1recomp",
    "gen1recomp",
    ["Green SGB Palette", "Mute Low HP Alarm", "Fade Overlay Fix", "Bag Stock Preview", "Fishing Mini Game"],
    "permission",
    "One creator conversation covers five unlicensed mods to avoid posting five repetitive requests.",
  ),
  githubTarget("mew-glitch-mod", "Mew Glitch Mod", "José Maceiras", "Chari69/mewmod", "gen1recomp", ["Mew Glitch Mod"]),
  githubTarget("oak-brief", "Oak Brief", "Yukita Mayako", "Yukitty/gen1mod_oak_brief", "gen1recomp", ["Oak Brief"]),
  githubTarget("anytime-rename", "Anytime Rename", "Roxas2712", "Roxas2712/pokemon-gen1-recomp-mod-anytime-rename", "gen1recomp", ["Anytime Rename"]),
  githubTarget("kanto-gear-license", "Kanto Gear", "AverageConsumer", "AverageConsumer/kanto-gear", "gen1recomp", ["Kanto Gear"], "license-packaging"),
  githubTarget("red-ptbr-license", "Pokémon Red PT-BR", "Gabriel Sojo", "bielsojo/red-ptbr-gen1recomp", "gen1recomp", ["Pokémon Red PT-BR"], "license-packaging"),
  githubTarget(
    "keberos-collection-license",
    "keberos Gen1Recomp mod collection",
    "keberos",
    "keberos/quickmap",
    "gen1recomp",
    ["Button Shortcuts", "Quick Map", "Rename Character"],
    "license-packaging",
    "One creator conversation covers three MIT repositories whose downloadable archives need license packaging confirmation.",
  ),
  githubTarget("too-many-balls-license", "Too Many Balls", "Mister Miracle", "mistermiracle3036/Too-Many-Balls", "gen1recomp", ["Too Many Balls"], "license-packaging"),
  githubTarget("gen2-dramatic-shapes", "Dramatic Shapes for Gen2", "UNDERdecodedHD", "UNDERdecoded/Gen2Recomped-DramaticShapes", "gen2recomp", ["Dramatic Shapes for Gen2"]),
  githubTarget("gen2-perfect-start", "Gen 2 Perfect Start", "Windwrecker", "Windwrecker/Gen1recomp-Perfect-Start", "gen2recomp", ["Gen 2 Perfect Start"]),
  githubTarget("gen2-3d-sprites", "Gen 2 3D Sprites", "randyadr", "randyadr/Gen2-3D-Sprites", "gen2recomp", ["Gen 2 3D Sprites"]),
];

function starterQueue() {
  return CURATED_TARGETS.map((target) => makeRequest(target));
}

function normalizeRequest(value: Partial<PermissionRequest>): PermissionRequest {
  return makeRequest({
    ...value,
    includedProjects: Array.isArray(value.includedProjects) ? value.includedProjects : [],
  });
}

function mergeCuratedTargets(savedRequests: PermissionRequest[]) {
  const merged = [...savedRequests];
  for (const target of starterQueue()) {
    const index = merged.findIndex((request) => request.targetKey === target.targetKey || request.projectUrl === target.projectUrl);
    if (index === -1) {
      merged.push(target);
      continue;
    }

    const previous = merged[index];
    const legacyDraft = !previous.targetKey && previous.status === "draft" && !previous.sentAt && !previous.reply;
    merged[index] = {
      ...target,
      ...previous,
      targetKey: target.targetKey,
      contactType: previous.contactUrl ? previous.contactType : target.contactType,
      contactLabel: previous.contactUrl ? previous.contactLabel : target.contactLabel,
      contactUrl: previous.contactUrl || target.contactUrl,
      outreachPurpose: target.outreachPurpose,
      includedProjects: target.includedProjects,
      subject: legacyDraft ? target.subject : previous.subject,
      message: legacyDraft ? target.message : previous.message,
      notes: previous.notes || target.notes,
    };
  }
  return merged;
}

function readStoredRequests() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return starterQueue();
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return starterQueue();
    const restored = parsed
      .filter((item): item is Partial<PermissionRequest> => Boolean(item && typeof item === "object" && "id" in item))
      .map(normalizeRequest);
    return mergeCuratedTargets(restored);
  } catch {
    return starterQueue();
  }
}

function assessReply(reply: string): Assessment {
  const normalized = reply.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return "unclear";
  if (/\b(do not|don't|cannot|can't|not allowed|no permission|decline|refuse|please remove)\b/.test(normalized)) {
    return "likely-denied";
  }
  if (
    /\b(i|we) (give|grant) .*permission\b/.test(normalized) ||
    /\b(you|phosphor index) (may|can|are allowed to) (mirror|host|redistribute)\b/.test(normalized) ||
    /\bpermission (is )?(granted|given)\b/.test(normalized)
  ) {
    return "likely-granted";
  }
  return "unclear";
}

function formatDate(value: string) {
  if (!value) return "Not yet";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function PermissionDesk() {
  const [requests, setRequests] = useState<PermissionRequest[]>(readStoredRequests);
  const [activeId, setActiveId] = useState(() => requests[0]?.id ?? "");
  const [filter, setFilter] = useState<QueueFilter>("all");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("Saved locally on this device");
  const importInput = useRef<HTMLInputElement>(null);
  const detailPanel = useRef<HTMLElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(requests));
  }, [requests]);

  const active = requests.find((request) => request.id === activeId) ?? null;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "open" && (request.status === "sent" || request.status === "follow-up")) ||
        (filter === "granted" && request.status === "granted") ||
        (filter === "blocked" && (request.status === "denied" || request.status === "unclear"));
      const haystack = `${request.projectName} ${request.creatorName} ${request.creatorEmail} ${request.contactLabel} ${(request.includedProjects ?? []).join(" ")}`.toLowerCase();
      return matchesFilter && (!needle || haystack.includes(needle));
    });
  }, [filter, query, requests]);
  const counts = useMemo(() => ({
    all: requests.length,
    projects: requests.reduce((total, request) => total + Math.max(1, request.includedProjects?.length ?? 0), 0),
    sent: requests.filter((request) => request.status === "sent" || request.status === "follow-up").length,
    granted: requests.filter((request) => request.status === "granted").length,
    blocked: requests.filter((request) => request.status === "denied" || request.status === "unclear").length,
  }), [requests]);

  function updateActive(patch: Partial<PermissionRequest>) {
    if (!active) return;
    setRequests((current) => current.map((request) => request.id === active.id ? { ...request, ...patch } : request));
  }

  function selectRequest(id: string) {
    setActiveId(id);
    if (window.matchMedia("(max-width: 1100px)").matches) {
      window.requestAnimationFrame(() => detailPanel.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function addRequest() {
    const request = makeRequest();
    setRequests((current) => [request, ...current]);
    setActiveId(request.id);
    setFilter("all");
    setNotice("New permission request created");
  }

  function regenerateMessage() {
    if (!active) return;
    updateActive({ subject: buildSubject(active), message: buildMessage(active) });
    setNotice("Canned message refreshed with current project details");
  }

  async function launchOutreach() {
    if (!active) return;
    const destination = active.contactType === "email" ? active.creatorEmail : active.contactUrl;
    if (!destination) {
      setNotice(`Add an official ${contactTypeLabels[active.contactType].toLowerCase()} contact first`);
      return;
    }

    let url = destination;
    if (active.contactType === "email") {
      url = `mailto:${encodeURIComponent(active.creatorEmail)}?subject=${encodeURIComponent(active.subject)}&body=${encodeURIComponent(active.message)}`;
    } else if (active.contactType === "github-issue") {
      const separator = destination.includes("?") ? "&" : "?";
      url = `${destination}${separator}title=${encodeURIComponent(active.subject)}&body=${encodeURIComponent(active.message)}`;
    } else {
      await navigator.clipboard.writeText(`${active.subject}\n\n${active.message}`);
    }

    window.open(url, "_blank", "noopener,noreferrer");
    updateActive({ status: "sent", sentAt: active.sentAt || new Date().toISOString() });
    setNotice(
      active.contactType === "discord"
        ? "Official Discord opened and the complete request was copied. Paste it into the appropriate project channel."
        : `Prepared ${contactTypeLabels[active.contactType].toLowerCase()} opened. Confirm the final send there.`,
    );
  }

  async function copyMessage() {
    if (!active) return;
    await navigator.clipboard.writeText(`Subject: ${active.subject}\n\n${active.message}`);
    setNotice("Message copied to clipboard");
  }

  function analyzeResponse() {
    if (!active) return;
    const assessment = assessReply(active.reply);
    updateActive({ assessment, repliedAt: active.repliedAt || new Date().toISOString() });
    setNotice(
      assessment === "likely-granted"
        ? "Looks promising. Verify the exact sharing scope before confirming."
        : assessment === "likely-denied"
          ? "Likely denied. Do not publish unless the creator clarifies."
          : "No explicit permission found. Ask for clarification.",
    );
  }

  function setDecision(status: "granted" | "denied" | "unclear") {
    if (!active) return;
    updateActive({ status, repliedAt: active.repliedAt || new Date().toISOString() });
    setNotice(status === "granted" ? "Decision recorded. Confirm both sharing checkboxes." : "Decision recorded");
  }

  function exportBackup() {
    const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), requests }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `phosphor-permissions-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Encrypted storage is not enabled. Keep this backup private.");
  }

  async function importBackup(file: File) {
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const candidate = parsed && typeof parsed === "object" && "requests" in parsed ? (parsed as { requests: unknown }).requests : parsed;
      if (!Array.isArray(candidate) || !candidate.every((item) => item && typeof item === "object" && "id" in item)) {
        throw new Error("Invalid permission backup");
      }
      const restored = mergeCuratedTargets((candidate as Partial<PermissionRequest>[]).map(normalizeRequest));
      setRequests(restored);
      setActiveId(restored[0]?.id ?? "");
      setNotice(`${restored.length} permission records restored`);
    } catch {
      setNotice("That file is not a valid Permission Desk backup");
    }
  }

  function deleteActive() {
    if (!active || !window.confirm(`Delete the permission record for ${active.projectName || "this project"}?`)) return;
    const next = requests.filter((request) => request.id !== active.id);
    setRequests(next);
    setActiveId(next[0]?.id ?? "");
    setNotice("Permission record deleted from this device");
  }

  const catalogReady = Boolean(
    active &&
    active.status === "granted" &&
    active.scope.mirrorFile &&
    active.scope.redistributeFree &&
    active.reply.trim(),
  );
  const contactReady = Boolean(active && (active.contactType === "email" ? active.creatorEmail : active.contactUrl));

  return (
    <div className="desk-shell">
      <header className="desk-topbar">
        <div className="desk-brand">
          <span className="desk-logo">P<span>_</span></span>
          <div><b>phosphor<span>_</span></b><small>{"// PERMISSION DESK"}</small></div>
        </div>
        <div className="desk-signal"><i /> LOCAL CONSOLE <span>·</span> PRIVATE DATA</div>
        <div className="top-actions">
          <button type="button" onClick={exportBackup}>↓ Backup</button>
          <button className="new-button" type="button" onClick={addRequest}>＋ New request</button>
        </div>
      </header>

      <main className="desk-main">
        <aside className="desk-sidebar">
          <div className="side-heading"><span>Queue control</span><small>OUTREACH / 01</small></div>
          <nav aria-label="Permission queue filters">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} type="button"><span>All requests</span><b>{counts.all}</b></button>
            <button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")} type="button"><span>Awaiting reply</span><b>{counts.sent}</b></button>
            <button className={filter === "granted" ? "active" : ""} onClick={() => setFilter("granted")} type="button"><span>Approved</span><b>{counts.granted}</b></button>
            <button className={filter === "blocked" ? "active" : ""} onClick={() => setFilter("blocked")} type="button"><span>Blocked / unclear</span><b>{counts.blocked}</b></button>
          </nav>
          <section className="privacy-card">
            <span aria-hidden="true">⌁</span>
            <div><b>Device-local vault</b><p>Records stay in this browser. Export backups regularly; clearing browser data removes them.</p></div>
          </section>
          <button className="import-button" type="button" onClick={() => importInput.current?.click()}>↑ Restore backup</button>
          <input
            ref={importInput}
            hidden
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importBackup(file);
              event.target.value = "";
            }}
          />
        </aside>

        <section className="queue-panel" aria-labelledby="queue-title">
          <div className="panel-heading">
            <div><p>{`// Outreach queue · ${counts.projects} projects`}</p><h1 id="queue-title">permission signals<span>_</span></h1></div>
            <label className="queue-search"><span aria-hidden="true">⌕</span><span className="sr-only">Search requests</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="search creator or project" /></label>
          </div>
          <div className="stat-strip">
            <div><span>CONTACTS</span><strong>{String(counts.all).padStart(2, "0")}</strong></div>
            <div><span>PROJECTS</span><strong>{String(counts.projects).padStart(2, "0")}</strong></div>
            <div><span>OPEN</span><strong>{String(counts.sent).padStart(2, "0")}</strong></div>
            <div className="good"><span>CLEARED</span><strong>{String(counts.granted).padStart(2, "0")}</strong></div>
            <div className="warn"><span>BLOCKED</span><strong>{String(counts.blocked).padStart(2, "0")}</strong></div>
          </div>
          <div className="request-list">
            <div className="list-labels"><span>Project / creator</span><span>Type</span><span>Status</span><span>Last signal</span></div>
            {visible.length ? visible.map((request) => (
              <button className={`request-row ${request.id === activeId ? "selected" : ""}`} key={request.id} onClick={() => selectRequest(request.id)} type="button">
                <span className="request-project"><i className={`status-dot ${statusMeta[request.status].tone}`} /><span><b>{request.projectName || "Untitled request"}</b><small>{request.creatorName || "Creator not set"}</small></span></span>
                <span>{kindLabels[request.kind]}</span>
                <span className={`status-pill ${statusMeta[request.status].tone}`}>{statusMeta[request.status].label}</span>
                <span>{formatDate(request.repliedAt || request.sentAt || request.createdAt)}</span>
              </button>
            )) : <div className="empty-queue">NO MATCHING SIGNALS<span>_</span></div>}
          </div>
        </section>

        <aside className="detail-panel" ref={detailPanel}>
          {active ? (
            <>
              <div className="detail-top">
                <div><p>ACTIVE RECORD · {active.id.slice(0, 8).toUpperCase()}</p><h2>{active.projectName || "New request"}</h2></div>
                <span className={`status-pill ${statusMeta[active.status].tone}`}>{statusMeta[active.status].label}</span>
              </div>

              <div className="detail-scroll">
                <section className="form-section">
                  <div className="form-section-title"><span>01</span><div><b>Creator & contact</b><small>Official public channel preloaded</small></div></div>
                  <div className={`contact-ready ${contactReady ? "ready" : "missing"}`}>
                    <span>{contactReady ? "READY" : "NEEDS CONTACT"}</span>
                    <div>
                      <b>{active.contactLabel || contactTypeLabels[active.contactType]}</b>
                      <small>{(active.includedProjects?.length ?? 0) > 1 ? `One message covers ${active.includedProjects.length} projects by this creator.` : "The canned request is ready for this project."}</small>
                    </div>
                  </div>
                  <div className="form-grid">
                    <label>Project<input value={active.projectName} onChange={(event) => updateActive({ projectName: event.target.value })} /></label>
                    <label>Creator / team<input value={active.creatorName} onChange={(event) => updateActive({ creatorName: event.target.value })} /></label>
                    <label>Contact channel<select value={active.contactType} onChange={(event) => {
                      const contactType = event.target.value as ContactType;
                      updateActive({ contactType, contactLabel: contactTypeLabels[contactType] });
                    }}><option value="github-issue">GitHub issue</option><option value="discord">Official Discord</option><option value="email">Public email</option></select></label>
                    <label>Contact label<input value={active.contactLabel} onChange={(event) => updateActive({ contactLabel: event.target.value })} /></label>
                    {active.contactType === "email" ? (
                      <label className="wide">Public email<input type="email" value={active.creatorEmail} onChange={(event) => updateActive({ creatorEmail: event.target.value })} placeholder="creator@example.com" /></label>
                    ) : (
                      <label className="wide">Official contact URL<input type="url" value={active.contactUrl} onChange={(event) => updateActive({ contactUrl: event.target.value })} /></label>
                    )}
                    <label className="wide">Project URL<input type="url" value={active.projectUrl} onChange={(event) => updateActive({ projectUrl: event.target.value })} /></label>
                    <label className="wide">Exact release URL<input type="url" value={active.releaseUrl} onChange={(event) => updateActive({ releaseUrl: event.target.value })} /></label>
                    <label>Release type<select value={active.kind} onChange={(event) => updateActive({ kind: event.target.value as ProjectKind })}><option value="rom-hack">ROM hack patch</option><option value="gen1recomp">Gen 1 recomp mod</option><option value="gen2recomp">Gen 2 recomp mod</option></select></label>
                    <label>Workflow status<select value={active.status} onChange={(event) => updateActive({ status: event.target.value as Status })}>{Object.entries(statusMeta).map(([value, meta]) => <option value={value} key={value}>{meta.label}</option>)}</select></label>
                  </div>
                </section>

                <section className="form-section">
                  <div className="form-section-title"><span>02</span><div><b>Outreach message</b><small>Explicit mirroring language</small></div></div>
                  <label>Subject<input value={active.subject} onChange={(event) => updateActive({ subject: event.target.value })} /></label>
                  <label>Message<textarea className="message-box" value={active.message} onChange={(event) => updateActive({ message: event.target.value })} /></label>
                  <div className="button-row">
                    <button type="button" onClick={regenerateMessage}>↻ Regenerate</button>
                    <button type="button" onClick={() => void copyMessage()}>□ Copy</button>
                    <button className="primary go-button" type="button" disabled={!contactReady} onClick={() => void launchOutreach()}>GO · {contactTypeLabels[active.contactType]} ↗</button>
                  </div>
                  <p className="inline-note">GO opens the creator&apos;s official channel with the request prefilled. You confirm the final post or send there; Discord requests are copied for pasting.</p>
                </section>

                <section className="form-section">
                  <div className="form-section-title"><span>03</span><div><b>Response evidence</b><small>Paste the creator&apos;s exact reply</small></div></div>
                  <label>Creator response<textarea value={active.reply} onChange={(event) => updateActive({ reply: event.target.value, assessment: "not-checked" })} placeholder="Paste the full reply here, including any conditions…" /></label>
                  <div className="assessment-line">
                    <button type="button" onClick={analyzeResponse}>Analyze wording</button>
                    <span className={`assessment ${active.assessment}`}>{active.assessment === "not-checked" ? "Not checked" : active.assessment.replace("likely-", "Likely ")}</span>
                  </div>
                  <p className="inline-note">The wording check is intentionally conservative and is not a legal determination. You confirm the final decision.</p>
                  <div className="decision-row" role="group" aria-label="Record permission decision">
                    <button className={active.status === "granted" ? "selected granted" : ""} type="button" onClick={() => setDecision("granted")}>✓ Confirm granted</button>
                    <button className={active.status === "unclear" ? "selected unclear" : ""} type="button" onClick={() => setDecision("unclear")}>? Needs clarification</button>
                    <button className={active.status === "denied" ? "selected denied" : ""} type="button" onClick={() => setDecision("denied")}>× Denied</button>
                  </div>
                  <label>Evidence URL<input type="url" value={active.evidenceUrl} onChange={(event) => updateActive({ evidenceUrl: event.target.value })} placeholder="Private message URL, issue comment, or archive link" /></label>
                </section>

                <section className="form-section">
                  <div className="form-section-title"><span>04</span><div><b>Approved scope</b><small>What exactly may be published?</small></div></div>
                  <div className="check-list">
                    <label><input aria-label="Mirror the exact patch or mod file" type="checkbox" checked={active.scope.mirrorFile} onChange={(event) => updateActive({ scope: { ...active.scope, mirrorFile: event.target.checked } })} /><span><b>Mirror the exact patch/mod file</b><small>Phosphor Index may host its own copy.</small></span></label>
                    <label><input aria-label="Freely redistribute the file" type="checkbox" checked={active.scope.redistributeFree} onChange={(event) => updateActive({ scope: { ...active.scope, redistributeFree: event.target.checked } })} /><span><b>Freely redistribute the file</b><small>Visitors may download it at no charge.</small></span></label>
                    <label><input aria-label="Use creator artwork and screenshots" type="checkbox" checked={active.scope.useCreatorImages} onChange={(event) => updateActive({ scope: { ...active.scope, useCreatorImages: event.target.checked } })} /><span><b>Use creator artwork/screenshots</b><small>Separate from permission to distribute the file.</small></span></label>
                    <label><input aria-label="Publish our own gameplay captures" type="checkbox" checked={active.scope.useOwnCaptures} onChange={(event) => updateActive({ scope: { ...active.scope, useOwnCaptures: event.target.checked } })} /><span><b>Publish our own gameplay captures</b><small>Captured from a legally patched game.</small></span></label>
                  </div>
                  <label>Conditions / attribution<textarea value={active.restrictions} onChange={(event) => updateActive({ restrictions: event.target.value })} placeholder="Required credit, non-commercial limit, version limits, withdrawal terms…" /></label>
                  <label>Internal notes<textarea value={active.notes} onChange={(event) => updateActive({ notes: event.target.value })} /></label>
                </section>

                <section className={`readiness-card ${catalogReady ? "ready" : "blocked"}`}>
                  <span>{catalogReady ? "✓" : "!"}</span>
                  <div><b>{catalogReady ? "Cleared for catalog review" : "Not cleared for publication"}</b><p>{catalogReady ? "Explicit response and both required distribution rights are recorded. Run the normal file and license review next." : "A pasted response, confirmed grant, mirror permission, and free redistribution permission are all required."}</p></div>
                </section>
                <button className="delete-button" type="button" onClick={deleteActive}>Delete this local record</button>
              </div>
            </>
          ) : (
            <div className="empty-detail"><span>P_</span><h2>No active record</h2><button className="primary" type="button" onClick={addRequest}>Create request</button></div>
          )}
        </aside>
      </main>
      <footer className="desk-footer"><span><i /> AUTOSAVE ON</span><p>{notice}</p><span>PHOSPHOR DESK · LOCAL V2</span></footer>
    </div>
  );
}

export default PermissionDesk;
