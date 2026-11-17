export interface Location { file: string; line: number; column: number }
export interface ImportUsage extends Location { specifier: string; package: string; symbols: string[]; kind: string }
export interface Finding {
  code: string; severity: 'error' | 'warning'; message: string;
  package?: string; symbol?: string; subpath?: string; locations?: Location[];
  semverSafeClaim?: boolean;
}
export interface TraceWarning { code: string; file: string; line: number; message: string }
export interface TraceResult { imports: ImportUsage[]; warnings: TraceWarning[] }
export interface Parameter { name: string; optional: boolean; rest: boolean; type: string }
export interface Signature { parameters: Parameter[]; returnType: string }
export interface ExportSymbol { type: string; calls: Signature[]; constructors: Signature[] }
export interface ApiSnapshot {
  available: boolean; typed?: boolean; entrypoint?: string;
  exports: Record<string, ExportSymbol>; diagnostics: string[];
}
export interface CandidateManifest {
  name?: string; version: string; peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}
export interface PeerIssue {
  package: string; peer: string; range: string; actual: string | null;
  optional: boolean; code: 'PEER_CONFLICT' | 'PEER_MISSING';
}
export interface AdvisorInput {
  current?: Record<string, string>; candidates: Record<string, CandidateManifest[]>;
  maxCombinations?: number;
}
export type AdvisorResult = {
  status: 'peer-compatible'; examined: number; truncated: boolean; changes: number;
  versions: Record<string, string>;
  npm: { dependencies: Record<string, string>; overrides: Record<string, string> };
  yarn: { resolutions: Record<string, string> }; pnpm: { overrides: Record<string, string> };
  caveats: string[];
} | {
  status: 'search-limit' | 'unsatisfiable'; examined: number; truncated: boolean;
  message: string; exampleConflicts: PeerIssue[];
};
export interface AnalyzeOptions { project: string; updates: { name?: string; before?: string; after: string }[] }
export interface Change {
  package: string; from: string; to: string; semver: string; imports: number;
  entrypoints: { subpath: string; before: ApiSnapshot; after: ApiSnapshot }[];
}
export interface AnalysisReport {
  schemaVersion: 1; status: 'blocked' | 'review' | 'no-static-break-detected';
  project: string; changes: Change[]; findings: Finding[]; trace: TraceResult;
  limitations: string[]; simulation: { status: 'not-run' };
}
export interface SimulationStep { phase: 'install' | 'test'; exitCode: number | null; stdout: string; stderr: string; error?: string }
export interface SimulationResult {
  status: 'passed' | 'failed' | 'timeout' | 'unavailable';
  message?: string; durationMs?: number; results?: SimulationStep[];
  versions?: Record<string, string>; caveats?: string[];
}
export interface SimulationOptions {
  project: string; versions?: Record<string, string>; command?: string[];
  image?: string; timeoutMs?: number; allowTestNetwork?: boolean;
  /** Test injection seam; omit for real Docker execution. */
  runner?: (file: string, args: string[], options: object) => {
    status?: number | null; stdout?: string; stderr?: string;
    error?: Error & { code?: string };
  };
}
export function traceImports(project: string): TraceResult;
export function sourceFiles(root: string): string[];
export function packageName(specifier: string): string;
export function entrypoint(root: string, subpath?: string): string | null;
export function snapshotApi(root: string, subpath?: string): ApiSnapshot;
export function compareApis(before: ApiSnapshot, after: ApiSnapshot, usage?: string[]): Finding[];
export function peerIssues(selection: Record<string, CandidateManifest>): PeerIssue[];
export function advise(input: AdvisorInput): AdvisorResult;
export function analyze(options: AnalyzeOptions): AnalysisReport;
export function toSarif(report: AnalysisReport): object;
export function parseUpgrade(spec: string): { name: string; version: string };
export function fetchPackage(spec: string): Promise<{ root: string; integrity?: string; cleanup(): void }>;
export function simulate(options: SimulationOptions): SimulationResult;
export function sandboxCommand(options: { name: string; stage: string; image: string; network: string; command: string[] }): string[];
