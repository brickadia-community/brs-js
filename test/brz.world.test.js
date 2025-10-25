const { encode } = require('@msgpack/msgpack');
const { brz, offsetBrzSave } = require('..');
const {
  parseComponentChunk,
  parseWireChunk,
} = brz.world;
const { SchemaDecoder } = brz.schema;

const concat = (...arrays) => {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    buffer.set(arr, offset);
    offset += arr.length;
  }
  return buffer;
};

const globalData = {
  entityTypeNames: [],
  basicBrickAssets: [],
  proceduralBrickAssets: [],
  materialAssets: [],
  componentTypeNames: ['TestComponent', 'RemoteComponent'],
  componentDataStructNames: ['TestStruct', 'None'],
  componentWirePortNames: ['Input', 'Output'],
  externalAssetReferences: [],
  proceduralBrickStartingIndex: 0,
};

const schemaDefinition = {
  enums: new Map(),
  structs: new Map([
    [
      'TestStruct',
      {
        name: 'TestStruct',
        properties: [{ name: 'Value', kind: 'type', valueType: 'f32' }],
      },
    ],
  ]),
};

const schemaDecoder = new SchemaDecoder(schemaDefinition);

describe('brz/world component parsing', () => {
  test('parseComponentChunk decodes instances and definitions', () => {
    const counters = encode([{ TypeIndex: 0, NumInstances: 1 }]);
    const brickIndices = encode([0]);
    const jointBrickIndices = encode([]);
    const jointEntityRefs = encode([]);
    const offsets = encode(new Uint8Array(0));
    const rotations = encode(new Uint8Array(0));
    const structValue = encode(1.5);

    const chunkBytes = concat(
      counters,
      brickIndices,
      jointBrickIndices,
      jointEntityRefs,
      offsets,
      rotations,
      structValue
    );

    const result = parseComponentChunk(
      chunkBytes,
      globalData,
      schemaDefinition,
      schemaDecoder
    );

    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({
      typeName: 'TestComponent',
      localBrickIndex: 0,
    });
    expect(result.instances[0].properties.Value).toBeCloseTo(1.5);

    const definition = result.definitions.get('TestComponent');
    expect(definition).toBeDefined();
    expect(definition.propertyTypes.Value).toBe('Float');
  });
});

describe('brz/world wire parsing', () => {
  test('parseWireChunk returns local and remote endpoints', () => {
    const remoteSources = encode([
      {
        GridPersistentIndex: 2,
        ChunkIndex: { X: 1, Y: 0, Z: -1 },
        BrickIndexInChunk: 3,
        ComponentTypeIndex: 1,
        PortIndex: 1,
      },
    ]);
    const localSources = encode([
      {
        BrickIndexInChunk: 0,
        ComponentTypeIndex: 0,
        PortIndex: 0,
      },
    ]);
    const remoteTargets = encode([
      {
        BrickIndexInChunk: 4,
        ComponentTypeIndex: 0,
        PortIndex: 1,
      },
    ]);
    const localTargets = encode([
      {
        BrickIndexInChunk: 5,
        ComponentTypeIndex: 0,
        PortIndex: 0,
      },
    ]);
    const pendingFlags = encode(new Uint8Array(0));

    const wireBytes = concat(
      remoteSources,
      localSources,
      remoteTargets,
      localTargets,
      pendingFlags
    );

    const parsed = parseWireChunk(wireBytes);

    expect(parsed.local).toHaveLength(1);
    expect(parsed.remote).toHaveLength(1);
    expect(parsed.local[0].source).toMatchObject({
      brickIndex: 0,
      componentTypeIndex: 0,
      portIndex: 0,
    });
    expect(parsed.remote[0].source).toMatchObject({
      gridPersistentIndex: 2,
      chunk: { x: 1, y: 0, z: -1 },
      brickIndex: 3,
      componentTypeIndex: 1,
      portIndex: 1,
    });
    expect(parsed.remote[0].target.brickIndex).toBe(4);
  });
});

describe('brz offset helper', () => {
  test('offsetBrzSave translates bricks and grids', () => {
    const sample = {
      format: 'brz',
      brick_count: 1,
      bricks: [
        {
          position: [1, 2, 3],
          size: [2, 2, 2],
          components: {},
        },
      ],
      brick_assets: [],
      colors: [],
      materials: [],
      brick_owners: [],
      physical_materials: [],
      dynamic_grids: [
        {
          id: 7,
          position: [10, 0, -5],
          rotation: [0, 0, 0, 1],
          brick_indices: [0],
        },
      ],
    };

    const shifted = offsetBrzSave(sample, [5, -5, 10]);

    expect(shifted.bricks[0].position).toEqual([6, -3, 13]);
    expect(shifted.dynamic_grids?.[0].position).toEqual([15, -5, 5]);
    // original object should remain unchanged
    expect(sample.bricks[0].position).toEqual([1, 2, 3]);
    expect(sample.dynamic_grids?.[0].position).toEqual([10, 0, -5]);
  });
});
