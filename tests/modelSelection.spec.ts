import { expect, test } from '@playwright/test';
import {
  defaultParams,
  isFlagParameter,
  parseCatalogBody,
  resolveSelection,
  type CatalogModel,
} from '../src/modelSelection';

const effortModel: CatalogModel = {
  id: 'effort-model',
  displayName: 'Effort Model',
  parameters: [
    {
      id: 'effort',
      displayName: 'Effort',
      values: [
        { value: 'low', displayName: 'Low' },
        { value: 'high', displayName: 'High' },
      ],
    },
    { id: 'fast', displayName: 'Fast', values: [{ value: 'false' }, { value: 'true' }] },
  ],
  variants: [
    {
      params: [
        { id: 'effort', value: 'low' },
        { id: 'fast', value: 'false' },
      ],
      displayName: 'Low',
    },
    {
      params: [
        { id: 'effort', value: 'high' },
        { id: 'fast', value: 'true' },
      ],
      displayName: 'High fast',
      isDefault: true,
    },
  ],
};

const plainModel: CatalogModel = { id: 'plain-model', displayName: 'Plain Model', parameters: [], variants: [] };

test('an unknown or empty model id resolves to nothing', () => {
  expect(resolveSelection([effortModel], '', [{ id: 'effort', value: 'low' }])).toEqual({
    modelId: '',
    modelParams: [],
  });
  expect(resolveSelection([effortModel], 'missing-model', [])).toEqual({ modelId: '', modelParams: [] });
});

test('a model with no parameters resolves to no params', () => {
  expect(resolveSelection([effortModel, plainModel], 'plain-model', [{ id: 'effort', value: 'low' }])).toEqual({
    modelId: 'plain-model',
    modelParams: [],
  });
});

test('the default variant fills every parameter that was not requested', () => {
  expect(resolveSelection([effortModel], 'effort-model', [])).toEqual({
    modelId: 'effort-model',
    modelParams: [
      { id: 'effort', value: 'high' },
      { id: 'fast', value: 'true' },
    ],
  });
  expect(defaultParams(effortModel)).toEqual([
    { id: 'effort', value: 'high' },
    { id: 'fast', value: 'true' },
  ]);
});

test('a requested value is kept only when the parameter allows it', () => {
  expect(
    resolveSelection([effortModel], 'effort-model', [
      { id: 'fast', value: 'false' },
      { id: 'effort', value: 'low' },
    ]).modelParams,
  ).toEqual([
    { id: 'effort', value: 'low' },
    { id: 'fast', value: 'false' },
  ]);
  expect(
    resolveSelection([effortModel], 'effort-model', [
      { id: 'effort', value: 'nope' },
      { id: 'fast', value: 'maybe' },
      { id: 'unknown', value: 'x' },
    ]).modelParams,
  ).toEqual([
    { id: 'effort', value: 'high' },
    { id: 'fast', value: 'true' },
  ]);
});

test('without a default variant the first value fills in, and an empty parameter is skipped', () => {
  const model: CatalogModel = {
    id: 'm',
    displayName: 'm',
    parameters: [
      { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] },
      { id: 'empty', values: [] },
    ],
    variants: [{ params: [{ id: 'effort', value: 'high' }], displayName: 'High' }],
  };
  expect(defaultParams(model)).toEqual([{ id: 'effort', value: 'low' }]);
});

test('a default variant is ignored for a parameter when its value is not allowed', () => {
  const model: CatalogModel = {
    id: 'm',
    displayName: 'm',
    parameters: [{ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }],
    variants: [{ params: [{ id: 'effort', value: 'ultra' }], displayName: 'Ultra', isDefault: true }],
  };
  expect(defaultParams(model)).toEqual([{ id: 'effort', value: 'low' }]);
});

test('only a true and false value set is a flag', () => {
  expect(isFlagParameter({ id: 'fast', values: [{ value: 'false' }, { value: 'true' }] })).toBe(true);
  expect(isFlagParameter({ id: 'fast', values: [{ value: 'true' }, { value: 'false' }] })).toBe(true);
  expect(isFlagParameter({ id: 'fast', values: [{ value: 'true' }] })).toBe(false);
  expect(isFlagParameter({ id: 'effort', values: [{ value: 'low' }, { value: 'high' }] })).toBe(false);
  expect(
    isFlagParameter({ id: 'x', values: [{ value: 'true' }, { value: 'false' }, { value: 'maybe' }] }),
  ).toBe(false);
});

test('a string catalog becomes models without parameters', () => {
  expect(parseCatalogBody({ models: ['north-model', 'south-model'] })).toEqual([
    { id: 'north-model', displayName: 'north-model', parameters: [], variants: [] },
    { id: 'south-model', displayName: 'south-model', parameters: [], variants: [] },
  ]);
});

test('an object catalog keeps display names, parameters, and variants', () => {
  const parsed = parseCatalogBody({
    models: [
      {
        id: 'effort-model',
        displayName: 'Effort Model',
        parameters: [{ id: 'effort', displayName: 'Effort', values: [{ value: 'low', displayName: 'Low' }] }],
        variants: [{ params: [{ id: 'effort', value: 'low' }], displayName: 'Low', isDefault: true }],
      },
      { id: 'bare-model', displayName: '' },
    ],
  });
  expect(parsed).toEqual([
    {
      id: 'effort-model',
      displayName: 'Effort Model',
      parameters: [{ id: 'effort', displayName: 'Effort', values: [{ value: 'low', displayName: 'Low' }] }],
      variants: [{ params: [{ id: 'effort', value: 'low' }], displayName: 'Low', isDefault: true }],
    },
    { id: 'bare-model', displayName: 'bare-model', parameters: [], variants: [] },
  ]);
});

test('an invalid catalog body is refused', () => {
  expect(parseCatalogBody({})).toBeUndefined();
  expect(parseCatalogBody({ models: 'north-model' })).toBeUndefined();
  expect(parseCatalogBody({ models: [1] })).toBeUndefined();
  expect(parseCatalogBody({ models: [{ displayName: 'No id' }] })).toBeUndefined();
  expect(parseCatalogBody({ models: ['north-model', { id: 'south-model' }] })).toBeUndefined();
  expect(parseCatalogBody(null)).toBeUndefined();
});
