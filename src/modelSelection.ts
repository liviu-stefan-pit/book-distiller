// Electron-free model catalog types and selection rules, shared by the main process and the renderer.

export type ModelParameterValue = { id: string; value: string };

export type CatalogParameter = {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
};

export type CatalogVariant = {
  params: ModelParameterValue[];
  displayName: string;
  description?: string;
  isDefault?: boolean;
};

export type CatalogModel = {
  id: string;
  displayName: string;
  parameters: CatalogParameter[];
  variants: CatalogVariant[];
};

export type ModelSelection = { modelId: string; modelParams: ModelParameterValue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function allows(parameter: CatalogParameter, value: string): boolean {
  return parameter.values.some((allowed) => allowed.value === value);
}

function fallbackParams(
  model: CatalogModel,
  requested: ReadonlyArray<ModelParameterValue>,
): ModelParameterValue[] {
  const defaultVariant = model.variants.find((variant) => variant.isDefault === true);
  const params: ModelParameterValue[] = [];
  for (const parameter of model.parameters) {
    if (parameter.values.length === 0) {
      continue;
    }
    const asked = requested.find((item) => item.id === parameter.id);
    if (asked && allows(parameter, asked.value)) {
      params.push({ id: parameter.id, value: asked.value });
      continue;
    }
    const preferred = defaultVariant?.params.find((item) => item.id === parameter.id);
    if (preferred && allows(parameter, preferred.value)) {
      params.push({ id: parameter.id, value: preferred.value });
      continue;
    }
    params.push({ id: parameter.id, value: parameter.values[0]!.value });
  }
  return params;
}

/** The default variant's values, or each parameter's first value, in catalog parameter order. */
export function defaultParams(model: CatalogModel): ModelParameterValue[] {
  return fallbackParams(model, []);
}

/** Keeps the requested values the catalog allows and fills in the rest with defaults. */
export function resolveSelection(
  models: ReadonlyArray<CatalogModel>,
  modelId: string,
  requested: ReadonlyArray<ModelParameterValue>,
): ModelSelection {
  const model = modelId === '' ? undefined : models.find((item) => item.id === modelId);
  if (!model) {
    return { modelId: '', modelParams: [] };
  }
  return { modelId: model.id, modelParams: fallbackParams(model, requested) };
}

/** A flag is a parameter whose only values are "true" and "false". */
export function isFlagParameter(parameter: CatalogParameter): boolean {
  if (parameter.values.length !== 2) {
    return false;
  }
  const values = parameter.values.map((item) => item.value);
  return values.includes('true') && values.includes('false');
}

function parseName(value: unknown): { displayName?: string } {
  return typeof value === 'string' && value !== '' ? { displayName: value } : {};
}

function parseParamList(value: unknown): ModelParameterValue[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const params: ModelParameterValue[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.value !== 'string') {
      return undefined;
    }
    params.push({ id: item.id, value: item.value });
  }
  return params;
}

function parseParameter(value: unknown): CatalogParameter | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || !Array.isArray(value.values)) {
    return undefined;
  }
  const values: CatalogParameter['values'] = [];
  for (const item of value.values) {
    if (!isRecord(item) || typeof item.value !== 'string') {
      return undefined;
    }
    values.push({ value: item.value, ...parseName(item.displayName) });
  }
  return { id: value.id, ...parseName(value.displayName), values };
}

function parseVariant(value: unknown): CatalogVariant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const params = parseParamList(value.params);
  if (!params) {
    return undefined;
  }
  const variant: CatalogVariant = {
    params,
    displayName: typeof value.displayName === 'string' ? value.displayName : '',
  };
  if (typeof value.description === 'string' && value.description !== '') {
    variant.description = value.description;
  }
  if (value.isDefault === true) {
    variant.isDefault = true;
  }
  return variant;
}

function parseModel(value: unknown): CatalogModel | undefined {
  if (typeof value === 'string') {
    return value === '' ? undefined : { id: value, displayName: value, parameters: [], variants: [] };
  }
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '') {
    return undefined;
  }
  const rawParameters = value.parameters ?? [];
  const rawVariants = value.variants ?? [];
  if (!Array.isArray(rawParameters) || !Array.isArray(rawVariants)) {
    return undefined;
  }
  const parameters: CatalogParameter[] = [];
  for (const item of rawParameters) {
    const parameter = parseParameter(item);
    if (!parameter) {
      return undefined;
    }
    parameters.push(parameter);
  }
  const variants: CatalogVariant[] = [];
  for (const item of rawVariants) {
    const variant = parseVariant(item);
    if (!variant) {
      return undefined;
    }
    variants.push(variant);
  }
  const displayName = typeof value.displayName === 'string' && value.displayName !== '' ? value.displayName : value.id;
  return { id: value.id, displayName, parameters, variants };
}

/**
 * Reads a list of model ids or model objects. A mixed list, or any entry that is neither a string nor a
 * valid object, makes the whole list invalid.
 */
export function parseModelList(list: unknown): CatalogModel[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const strings = list.filter((item) => typeof item === 'string').length;
  if (strings !== 0 && strings !== list.length) {
    return undefined;
  }
  const models: CatalogModel[] = [];
  for (const item of list) {
    const model = parseModel(item);
    if (!model) {
      return undefined;
    }
    models.push(model);
  }
  return models;
}

/** Parses a catalog file body: `{ models: string[] }` or `{ models: [{ id, displayName?, parameters?, variants? }] }`. */
export function parseCatalogBody(body: unknown): CatalogModel[] | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return parseModelList(body.models);
}

/** Reads a saved list of params. Anything malformed is an empty list. */
export function parseSavedParams(value: unknown): ModelParameterValue[] {
  return parseParamList(value) ?? [];
}
