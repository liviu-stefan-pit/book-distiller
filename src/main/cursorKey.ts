import { app } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  parseCatalogBody,
  parseModelList,
  parseSavedParams,
  resolveSelection,
  type CatalogModel,
  type ModelParameterValue,
  type ModelSelection,
} from '../modelSelection';

export type SaveKeyResult =
  | { status: 'saved'; models: CatalogModel[]; modelId: string; modelParams: ModelParameterValue[] }
  | { status: 'error'; message: string };

export type Session = {
  hasKey: boolean;
  models: CatalogModel[];
  modelId: string;
  modelParams: ModelParameterValue[];
  folderPath: string;
};

type Settings = {
  models: CatalogModel[];
  modelId: string;
  modelParams: ModelParameterValue[];
  folderPath: string;
};

const vaultResource = 'Book Distiller';
const vaultUser = 'cursor';
let settingsChain = Promise.resolve();

export async function saveCursorKey(apiKey: string): Promise<SaveKeyResult> {
  const listed = await listCatalog(apiKey);
  if ('message' in listed) {
    return { status: 'error', message: listed.message };
  }
  const previous = await storedKey();
  let saved: Settings;
  try {
    await storeKey(apiKey);
    saved = await updateSettings((settings) => {
      settings.models = listed.models;
      reconcile(settings);
    });
  } catch {
    if (previous === undefined) {
      await removeStoredKey();
    } else {
      await storeKey(previous);
    }
    return { status: 'error', message: 'The key could not be saved.' };
  }
  return { status: 'saved', models: saved.models, modelId: saved.modelId, modelParams: saved.modelParams };
}

export async function forgetCursorKey(): Promise<void> {
  await removeStoredKey();
  await updateSettings((settings) => {
    settings.models = [];
    settings.modelId = '';
    settings.modelParams = [];
  });
}

/** Saves the model and its params together. Returns what was kept after checking the catalog. */
export async function rememberModel(modelId: string, modelParams: ModelParameterValue[]): Promise<ModelSelection> {
  const saved = await updateSettings((settings) => {
    const selection = resolveSelection(settings.models, modelId, Array.isArray(modelParams) ? modelParams : []);
    settings.modelId = selection.modelId;
    settings.modelParams = selection.modelParams;
  });
  return { modelId: saved.modelId, modelParams: saved.modelParams };
}

/** Keeps the saved model and params only as far as the catalog allows them. */
function reconcile(settings: Settings): void {
  const selection = resolveSelection(settings.models, settings.modelId, settings.modelParams);
  settings.modelId = selection.modelId;
  settings.modelParams = selection.modelParams;
}

export async function rememberFolder(folderPath: string): Promise<void> {
  await updateSettings((settings) => {
    settings.folderPath = folderPath;
  });
}

export async function loadSession(): Promise<Session> {
  if (process.env.BOOK_DISTILLER_SESSION === 'fail') {
    throw new Error('The saved key could not be read.');
  }
  const delay = Number(process.env.BOOK_DISTILLER_SESSION_DELAY_MS);
  if (Number.isInteger(delay) && delay >= 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const settings = await readSettings();
  const hasKey = await keyIsStored();
  if (!hasKey) {
    return { hasKey: false, models: [], modelId: '', modelParams: [], folderPath: settings.folderPath };
  }
  const fresh = await refreshedCatalog();
  let current: Settings;
  try {
    current = await updateSettings(
      (next) => {
        if (fresh) {
          next.models = fresh;
        }
        reconcile(next);
      },
      { skipUnchanged: true },
    );
  } catch {
    // A launch must still work when the reconciled selection cannot be written.
    current = { ...settings, models: fresh ?? settings.models };
    reconcile(current);
  }
  return {
    hasKey: true,
    models: current.models,
    modelId: current.modelId,
    modelParams: current.modelParams,
    folderPath: current.folderPath,
  };
}

/** The live catalog for the stored key, or undefined when it cannot be had. The cached catalog then stays. */
async function refreshedCatalog(): Promise<CatalogModel[] | undefined> {
  try {
    const listed = await listCatalog(await readCursorKey());
    return 'models' in listed ? listed.models : undefined;
  } catch {
    return undefined;
  }
}

async function listCatalog(apiKey: string): Promise<{ models: CatalogModel[] } | { message: string }> {
  const catalogFile = process.env.BOOK_DISTILLER_CATALOG_FILE;
  if (catalogFile) {
    try {
      const body = JSON.parse(await readFile(catalogFile, 'utf8')) as { error?: unknown };
      if (typeof body === 'object' && body !== null && typeof body.error === 'string') {
        return { message: body.error };
      }
      const models = parseCatalogBody(body);
      if (!models) {
        return { message: 'The key could not be saved.' };
      }
      return { models };
    } catch {
      return { message: 'The key could not be saved.' };
    }
  }
  try {
    const { Cursor } = await import('@cursor/sdk');
    const listed = await Cursor.models.list({ apiKey });
    const models = parseModelList(
      listed.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        parameters: model.parameters ?? [],
        variants: model.variants ?? [],
      })),
    );
    if (!models) {
      return { message: 'The key could not be saved.' };
    }
    return { models };
  } catch (error) {
    const message = error instanceof Error && error.message !== '' ? error.message : 'The key could not be saved.';
    return { message };
  }
}

async function storeKey(apiKey: string): Promise<void> {
  if (process.env.BOOK_DISTILLER_VAULT === 'memory') {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(memoryVaultPath(), JSON.stringify({ key: apiKey }), 'utf8');
    return;
  }
  await writePasswordVault(apiKey);
}

export async function readCursorKey(): Promise<string> {
  if (process.env.BOOK_DISTILLER_VAULT === 'memory') {
    const body = JSON.parse(await readFile(memoryVaultPath(), 'utf8')) as { key?: unknown };
    if (typeof body.key !== 'string' || body.key === '') {
      throw new Error('The key could not be read.');
    }
    return body.key;
  }
  const { code, stdout } = await runPowerShellCapture(`
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $existing = $vault.Retrieve('${vaultResource}', '${vaultUser}')
  $existing.RetrievePassword()
  [Console]::Out.Write($existing.Password)
} catch {
  exit 2
}
`);
  if (code !== 0 || stdout === '') {
    throw new Error('The key could not be read.');
  }
  return stdout;
}

async function keyIsStored(): Promise<boolean> {
  if (process.env.BOOK_DISTILLER_VAULT === 'memory') {
    try {
      const body = JSON.parse(await readFile(memoryVaultPath(), 'utf8')) as { key?: unknown };
      return typeof body.key === 'string' && body.key !== '';
    } catch {
      return false;
    }
  }
  const code = await runPowerShell(`
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $null = $vault.Retrieve('${vaultResource}', '${vaultUser}')
} catch {
  exit 2
}
`);
  if (code === 0) {
    return true;
  }
  if (code === 2) {
    return false;
  }
  throw new Error('The key could not be saved.');
}

function memoryVaultPath(): string {
  return join(app.getPath('userData'), 'memory-vault.json');
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

async function readSettings(): Promise<Settings> {
  try {
    const body = JSON.parse(await readFile(settingsPath(), 'utf8')) as {
      models?: unknown;
      modelIds?: unknown;
      modelId?: unknown;
      modelParams?: unknown;
      folderPath?: unknown;
    };
    // Older files only have modelIds, which are models without parameters.
    const models = parseModelList(body.models) ?? parseModelList(body.modelIds) ?? [];
    return {
      models,
      modelId: typeof body.modelId === 'string' ? body.modelId : '',
      modelParams: parseSavedParams(body.modelParams),
      folderPath: typeof body.folderPath === 'string' ? body.folderPath : '',
    };
  } catch {
    return { models: [], modelId: '', modelParams: [], folderPath: '' };
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  if (process.env.BOOK_DISTILLER_SETTINGS_FAIL === '1') {
    delete process.env.BOOK_DISTILLER_SETTINGS_FAIL;
    throw new Error('The key could not be saved.');
  }
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(settingsPath(), JSON.stringify(settings), 'utf8');
}

async function storedKey(): Promise<string | undefined> {
  if (process.env.BOOK_DISTILLER_VAULT === 'memory') {
    try {
      const body = JSON.parse(await readFile(memoryVaultPath(), 'utf8')) as { key?: unknown };
      if (typeof body.key === 'string' && body.key !== '') {
        return body.key;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (!(await keyIsStored())) {
    return undefined;
  }
  return readCursorKey();
}

async function removeStoredKey(): Promise<void> {
  if (process.env.BOOK_DISTILLER_VAULT === 'memory') {
    await rm(memoryVaultPath(), { force: true });
    return;
  }
  await removePasswordVault();
}

function updateSettings(
  change: (settings: Settings) => void,
  options: { skipUnchanged?: boolean } = {},
): Promise<Settings> {
  const run = settingsChain.then(async (): Promise<Settings> => {
    const settings = await readSettings();
    const before = JSON.stringify(settings);
    change(settings);
    if (!options.skipUnchanged || JSON.stringify(settings) !== before) {
      await writeSettings(settings);
    }
    return settings;
  });
  settingsChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writePasswordVault(apiKey: string): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$encoded = [Console]::In.ReadToEnd().Trim()
$password = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encoded))
$vault = New-Object Windows.Security.Credentials.PasswordVault
$resource = '${vaultResource}'
$userName = '${vaultUser}'
$previous = $null
try {
  $existing = $vault.Retrieve($resource, $userName)
  $existing.RetrievePassword()
  $previous = $existing.Password
  $vault.Remove($existing)
} catch {
  $previous = $null
}
try {
  $created = New-Object Windows.Security.Credentials.PasswordCredential($resource, $userName, $password)
  $vault.Add($created)
} catch {
  if ($null -ne $previous) {
    $restore = New-Object Windows.Security.Credentials.PasswordCredential($resource, $userName, $previous)
    try { $vault.Add($restore) } catch { }
  }
  exit 1
}
`;
  const code = await runPowerShell(script, Buffer.from(apiKey, 'utf8').toString('base64'));
  if (code !== 0) {
    throw new Error('The key could not be saved.');
  }
}

async function removePasswordVault(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
  $existing = $vault.Retrieve('${vaultResource}', '${vaultUser}')
} catch {
  exit 0
}
$vault.Remove($existing)
`;
  const code = await runPowerShell(script);
  if (code !== 0) {
    throw new Error('The key could not be saved.');
  }
}

function runPowerShellCapture(script: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr?.resume();
    child.on('error', () => {
      reject(new Error('The key could not be read.'));
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

function runPowerShell(script: string, stdin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {
      reject(new Error('The key could not be saved.'));
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
    if (!child.stdin) {
      reject(new Error('The key could not be saved.'));
      return;
    }
    if (stdin === undefined) {
      child.stdin.end();
      return;
    }
    child.stdin.end(stdin);
  });
}
