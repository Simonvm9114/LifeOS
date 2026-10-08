# LifeOS 8.761.0 — the Life Operating System

> **LifeOS is the AI harness that moves you from current state to ideal state — an intent engineering platform. The DA is the principal's AI assistant. Pulse is the Life Dashboard.**
> Canonical thesis: `LIFEOS/DOCUMENTATION/LifeOs/LifeOsThesis.md`. Everyone running LifeOS names their own DA. LifeOS targets AS3 on the LifeOS Maturity Model, with lineage from "The Real Internet of Things" (2016).

@LIFEOS/DOCUMENTATION/ARCHITECTURE_SUMMARY.md
# Identity @-imports below are activated by the agentic `/LifeOS setup` (via `skills/LifeOS/Tools/ActivateImports.ts`) once the principal scaffolds USER files.
# Claude Code follows nested @-imports only to a limited depth; identity files are listed here directly so the startup set is explicit in one place (public issue #2233, @jacobo-ortiz).
<!-- @LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md -->
<!-- @LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md -->
<!-- @LIFEOS/USER/DIGITAL_ASSISTANT/DA_IDENTITY.md -->
<!-- @LIFEOS/USER/PROJECTS.md -->
<!-- @LIFEOS/USER/CONFIG/OPERATIONAL_PREFERENCES.md -->

## Constitutional layer

Constitutional rules, the unified response format, verification doctrine, hard prohibitions, security protocol, and operational rules all live in the system prompt: `LIFEOS/LIFEOS_SYSTEM_PROMPT.md`. When this file and the system prompt disagree, the system prompt wins.

This file is the **routing table** — it tells you where everything lives. The only mandatory startup `@`-import shipped with public LifeOS is `ARCHITECTURE_SUMMARY`. The five identity files (`PRINCIPAL_TELOS`, `PRINCIPAL_IDENTITY`, `DA_IDENTITY`, `PROJECTS`, `OPERATIONAL_PREFERENCES`) are commented out above — the agentic `/LifeOS setup` (via `skills/LifeOS/Tools/ActivateImports.ts`) uncomments them once the principal's USER scaffold is populated. Claude Code follows nested `@`-imports only to a limited depth; identity files are listed here directly so the startup set is explicit in one place. Everything below is **on-demand** lookup. Paths are relative to `~/.claude/` unless noted.

## LifeOS System (paths under `LIFEOS/DOCUMENTATION/` unless noted)

- **Life OS thesis** — `LifeOs/LifeOsThesis.md` (canonical source of truth)
- **Life OS schema** — `LifeOs/LifeOsSchema.md` (biography-flat, PascalCase, frontmatter contract)
- **Hill climbing** (the one loop LifeOS runs; the HillClimb skill is its front door) — `LifeOs/HillClimbing.md`
- **System prompt** — `LIFEOS/LIFEOS_SYSTEM_PROMPT.md` (loaded via `--append-system-prompt-file`; home of the constitutional rules and response format)
- **System architecture** — `LifeosSystemArchitecture.md` (master doc)
- **Architecture summary** — `ARCHITECTURE_SUMMARY.md` (loaded via @-import)
- **Core components** (canonical two-tier component map) — `CoreComponents.md`
- Algorithm (the unified thinking system) — `Algorithm/AlgorithmSystem.md`
- Cortex (the memory system) — `Memory/MemorySystem.md`
- Skills — `Skills/SkillSystem.md`
- Hooks — `Hooks/HookSystem.md`
- Agents — `Agents/AgentSystem.md`
- Delegation — `Delegation/DelegationSystem.md` (retired except § Dispatch practice, which is current: how a leg is sent; agent orchestration is otherwise native harness surface: tool schemas + Algorithm §Spend election rules)
- The Router (who runs what, on which model, at what effort; `bun LIFEOS/ROUTER/Router.ts lanes|resolve|status`) — `Router/RouterSystem.md`
- Security — `Security/README.md` (defensive architecture) · conceptual model `Security/SecurityModel.md`
- Security Rings (who can reach what, by trust ring: rings hold their members, a conversation takes its least-trusted member's ring, one policy per ring; `bun LIFEOS/RINGS/Rings.ts validate|list|resolve`) — `SecurityRings/SecurityRingsSystem.md`
- Notifications — `Notifications/NotificationSystem.md`
- Observability — `Observability/ObservabilitySystem.md`
- Pulse — `Pulse/PulseSystem.md`
- Pulse metadata catalog (badges/strips/panels) — `Pulse/PulseMetadata.md`
- Pulse tooltips — `Pulse/Tooltips.md`
- DA subsystem (design) — `Pulse/DaSubsystem.md`
- Ledger (change tracking: versioning, update registry, integrity gate, deploy events) — `Ledger/LedgerSystem.md`
- Upgrades (the system-improvement queue) — `Upgrades/UpgradesSystem.md`
- Atlas (current state of everything you own; `atlas` CLI, Pulse `/atlas`) — `Atlas/AtlasSystem.md`
- Bunker (universal application harness — six planes, ISA-as-test-suite; concept doc, reference implementation not shipped) — `Bunker/BunkerSystem.md`
- Synapse (input router — capture → amber ledger → grade vs TELOS → route) — `Synapse/SynapseSystem.md`
- Conduit (sensory layer — local current-state capture, feeds memory + TELOS) — `Conduit/ConduitSystem.md`
- Work system (capture surfaces → private GitHub Issues as system of record) — `Work/WorkSystem.md`
- Background services (every recurring job + the one-shot installer) — `Services/BackgroundServices.md`
- Hermes sidecar (optional second front door — talk to your LifeOS as an agent) — `Hermes/HermesSidecar.md`
- Achilles (vulnerability management: registry + Pulse `/achilles` + Synapse leg + remediation ping; `bun LIFEOS/TOOLS/Achilles.ts`) — `Achilles/AchillesSystem.md`
- Assay (output checks against the ideal state each output was made for: deterministic asserts first, calibrated judges after, a receipt bound to the exact bytes; its judgment layer is the typed-question system with calibrated probabilities, caller thresholds, and shadow/enforce modes, `LIFEOS/ASSAY/Assay.ts`; `Skill("Assay")`) — `Assay/AssaySystem.md`
- Errata (complaint ledger: verbatim capture, enrichment, and triage into Upgrades; `Skill("Errata")`) — `Errata/ErrataSystem.md`
- Tex (texting your DA over iMessage through the Relay bridge in `LIFEOS/RELAY/`; the operator skill is optional and NOT in the public release payload) — `Tex/TexSystem.md`
- AS3 outcome probes (the far-end capability target, checked against real artifacts rather than labels, with the confirmation probe a static code check that does not execute the tools; `bun LIFEOS/AS3/Probes.ts <probe> [--json]`) — `LIFEOS/AS3/Probes.ts`
- Dictation (optional push-to-talk into your dictation app from a foot pedal or hotkey; `bun LIFEOS/DICTATION/Dictation.ts check|setup`) — `Dictation/DictationSystem.md`
- Voice mode (a session becomes a spoken conversation; `/voice`, `bun LIFEOS/TOOLS/VoiceMode.ts`) — `VoiceMode/VoiceMode.md`
- Workflows (the one system for deterministic and semi-deterministic work: typed actions and `*.workflow.yaml` definitions with schema-checked hand-offs, run locally or on Cloudflare Workers, plus one inventory of every piece of work LifeOS runs; `bun LIFEOS/WORKFLOWS/workflow.ts help --json`; Pulse `/workflows`) — `Workflows/WorkflowsSystem.md`
- Vera (versioned ideal-state profiles of people: claim ledger + projections + Pulse `/vera`; `bun LIFEOS/VERA/Vera.ts`) — `Vera/VeraSystem.md`
- People (one record per person + Apple two-way identity sync + typed interaction ledger + customer state + hourly tick; `bun LIFEOS/PEOPLE/People.ts who <q>`) — `People/PeopleSystem.md`
- Socrates (standing-question ledger: registry + scheduled three-valued answers + action router + Pulse `/socrates`; `bun LIFEOS/SOCRATES/Socrates.ts`) — `Socrates/SocratesSystem.md`
- Vigil (the always-on monitoring layer: one event log and a five-minute tick that routes each event by severity to a text, the digest or the dashboard; the engine `LIFEOS/VIGIL/` and the `Vigil` skill ship, per-install state lives in `LIFEOS/USER/VIGIL/`) — `Vigil/VigilSystem.md`
- STATVS (said "status"; the one permanent record of what happened across LifeOS and its apps; every STATE file is a rebuildable view; `Skill("Statvs")`, `bun LIFEOS/STATVS/Statvs.ts verify|drill|compare <view>`) — `Statvs/StatvsSystem.md`
- CENSVS (said "census"; the register of everything LifeOS owns or watches: every noun is one RES of a kind in GENERA, its state is its STATVS rows folded; `bun LIFEOS/CENSVS/Censvs.ts kinds|list|show <id>`) — `Censvs/CensvsSystem.md`
- Location (where the principal is, from their phone: a tracker posts fixes to a Worker, a sync writes an owner-only `USER/LOCATION/current.json`, and `here()` in `LIFEOS/LOCATION/Here.ts` is the one reader; "where am I" is `bun LIFEOS/LOCATION/Location.ts now`) — `Location/LocationSystem.md`
- Overage (the emergency pay-per-token lane for when a plan window caps: armed per session with the principal's approval, one monthly ceiling, spend shown on the status line; `bun LIFEOS/TOOLS/Overage.ts status`) — `Overage/OverageSystem.md`
- Maestro front door (optional; the `claude` launcher that attaches the system prompt and one merged prompt file) — `Maestro/MaestroFrontDoor.md`
- Lockbox (the one MCP door into LifeOS for every non-terminal client: Relay, Hermes, Pulse modules, outside agents; three scopes, `da.ask`, curated read tools, server-side confirm, tunnel + Access for remote reach; designed, first milestone not built) — `Lockbox/LockboxSystem.md`
- Codex front door (the same install opened from Codex CLI: symlink mirror + hook bridge; `bun LIFEOS/CODEX/Mount.ts`; code `LIFEOS/CODEX/`) — `Codex/CodexFrontDoor.md`
- Session restore (bring back killed Claude/Codex sessions from the live-sessions registry; `bun LIFEOS/TOOLS/Sessions.ts`) — `Sessions/SessionRestore.md`
- Helm (the LifeOS terminal; optional) — `Terminal/Helm.md`
- Risk register (TELOS `## Risks (RN)`: the cross-domain scenarios most likely to take you off your path, each with prevent / detect / respond state; `bun LIFEOS/TOOLS/TelosRisks.ts list|show|validate --links`) — `Telos/RiskRegister.md`
- Custom spinner verbs + tips — `Spinner/SpinnerSystem.md`
- Brand assets — `BrandAssets.md`
- CLI tools (Algorithm + action runner) — `Tools/Cli.md`
- CLI-first architecture — `Tools/CliFirstArchitecture.md`
- Configuration — `Config/ConfigSystem.md`
- Containment policy — `Tools/Containment.md`
- Feed — `Feed/FeedSystem.md`
- Fabric — `Fabric/FabricSystem.md`
- Freshness convention (`lifeos-freshness-v1`) — `Freshness/FreshnessSystem.md`
- Terminal tabs — `Pulse/TerminalTabs.md`
- Tools reference — `Tools/Tools.md`
- ISA — `ISA/ISASystem.md`
- ISA format spec — `ISA/ISAFormat.md`
- Testing doctrine — `Testing/TestingDoctrine.md`
- System/user boundary — `SystemUserBoundary.md` (which files are SYSTEM, which are USER, how the boundary is enforced)
- AI writing patterns (system-level reference) — `Writing/AIWritingPatterns.md`
- Browser automation — `Skill("Interceptor")` (real Chrome, mandatory for verification)
- Claude Code knowledge — `Agent(subagent_type="claude-code-guide")`

## Principal — Identity & Voice (paths under `LIFEOS/USER/`)

Populated during `/LifeOS setup`. Typical layout:

- Principal identity — `PRINCIPAL/PRINCIPAL_IDENTITY.md` (canonical, @-imported)
- Career & resume — `PRINCIPAL/RESUME.md`
- Writing style — `PRINCIPAL/WRITINGSTYLE.md`
- Pronunciations — `PRINCIPAL/PRONUNCIATIONS.json` (TTS rules — Pulse VoiceServer reads this)
- Contacts — `CONTACTS.md`
- Definitions — `DEFINITIONS.md`
- Core content themes — `CANONICAL_CONTENT.md`

## Principal — Life Goals

- TELOS (single source of truth, unified H2 sections) — `LIFEOS/USER/TELOS/TELOS.md`
- Auto-generated derivative — `LIFEOS/USER/TELOS/PRINCIPAL_TELOS.md`
- Dimension percentages — `LIFEOS/USER/TELOS/LIFEOS_STATE.json` (Pulse rings + statusline read from this)
- Freshness convention — see `LIFEOS/DOCUMENTATION/Freshness/FreshnessSystem.md`

## Principal — Work (paths under `LIFEOS/USER/`)

> These are the conventional locations for your own content. A fresh install ships the scaffold, not the folders — create each one when you first put something in it.

- Business — `BUSINESS/`
- Health — `HEALTH/`
- Finances — `FINANCES/`
- Integration configs — `INTEGRATIONS/*.yaml`
- Work system — `WORK/config.yaml`
- Secrets — `~/.claude/.env` (canonical; see OPERATIONAL_PREFERENCES.md)

## Project-Specific Rules

A project's own `CLAUDE.md` loads only when the session starts in that directory. `lifeos` changes to the install root by default, so launch with `lifeos --local` from the project directory to get it (public issue #2176, @selinium).
