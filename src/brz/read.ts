import { BrzArchive } from './archive';
import { MsgPackReader } from './msgpack';
import {
  buildWriteBricks,
  convertChunkToBricks,
  parseBrickChunk,
  parseGlobalData,
  parseOwnerTable,
  ParsedGlobalData,
  IntermediateBrick,
  OwnerRecord,
  parseEntityChunk,
  transformBricks,
  collectUniqueColors,
  GridTransform,
  parseComponentChunk,
  ComponentDefinitionInfo,
  parseWireChunk,
  RemoteWireEndpoint,
} from './world';
import { parseSchema, SchemaDefinition, SchemaDecoder } from './schema';
import {
  ReadOptions,
  WriteSaveObject,
  Owner,
  BrzReadSaveObject,
  Wire,
  UnrealColor,
  DynamicGridInfo,
  Vector,
} from '../types';

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

function decodeUtf8(bytes: Uint8Array): string {
  if (!textDecoder) {
    throw new Error('TextDecoder not available in this environment');
  }
  return textDecoder.decode(bytes);
}

function safeParseJson(bytes: Uint8Array): any {
  try {
    const text = decodeUtf8(bytes);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMeta(
  archive: BrzArchive
): Partial<Pick<WriteSaveObject, 'map' | 'description' | 'author' | 'host' | 'game_version'>> {
  const meta: Partial<Pick<WriteSaveObject, 'map' | 'description' | 'author' | 'host' | 'game_version'>> =
    {};

  if (archive.hasFile('Meta/World.json')) {
    const data = safeParseJson(archive.readFile('Meta/World.json'));
    if (data) {
      if (typeof data.name === 'string') {
        meta.map = data.name;
      }
      if (typeof data.description === 'string') {
        meta.description = data.description;
      }
      if (typeof data.gameVersion === 'number') {
        meta.game_version = data.gameVersion;
      }
      if (data.author && typeof data.author === 'object') {
        const { id, name } = data.author as { id?: string; name?: string };
        meta.author = {
          id: typeof id === 'string' ? id : undefined,
          name: typeof name === 'string' ? name : undefined,
        };
      }
      if (data.host && typeof data.host === 'object') {
        const { id, name } = data.host as { id?: string; name?: string };
        meta.host = {
          id: typeof id === 'string' ? id : undefined,
          name: typeof name === 'string' ? name : undefined,
        };
      }
    }
  }

  return meta;
}

function mapOwners(records: OwnerRecord[]): Partial<Owner>[] {
  if (!records.length) {
    return [];
  }
  return records.map(record => ({
    id: record.id,
    name: record.name,
    display_name: record.displayName,
    bricks: record.brickCount,
  }));
}

function extractPhysicalMaterials(global: ParsedGlobalData): string[] {
  const materials = Array.from(
    new Set(
      global.externalAssetReferences
        .filter(ref => ref.assetType === 'PhysicalMaterial')
        .map(ref => ref.assetName)
    )
  );

  if (materials.length > 0) {
    return materials;
  }
  return ['BPMC_Default'];
}

function tryReadPalette(archive: BrzArchive): UnrealColor[] | null {
  const palettePaths = ['World/0/Palette.mps', 'World/0/Bricks/Palette.mps'];
  for (const path of palettePaths) {
    if (!archive.hasFile(path)) continue;
    try {
      const reader = new MsgPackReader(archive.readFile(path));
      const colors: UnrealColor[] = [];
      const clamp = (value: unknown, fallback: number) => {
        if (typeof value !== 'number') {
          return fallback;
        }
        return Math.max(0, Math.min(255, Math.round(value)));
      };

      const collect = (value: any) => {
        if (Array.isArray(value)) {
          if (value.length >= 4 && value.every(v => typeof v === 'number')) {
            colors.push([
              clamp(value[0], 0),
              clamp(value[1], 0),
              clamp(value[2], 0),
              clamp(value[3], 255),
            ]);
          } else {
            for (const item of value) collect(item);
          }
        } else if (value && typeof value === 'object') {
          const maybe =
            value.R ?? value.r ?? value.red ?? value.Red ?? undefined;
          if (maybe !== undefined) {
            const r = clamp(
              value.R ?? value.r ?? value.red ?? value.Red,
              0
            );
            const g = clamp(
              value.G ?? value.g ?? value.green ?? value.Green,
              0
            );
            const b = clamp(
              value.B ?? value.b ?? value.blue ?? value.Blue,
              0
            );
            const a = clamp(
              value.A ?? value.a ?? value.alpha ?? value.Alpha,
              255
            );
            colors.push([r, g, b, a]);
          } else {
            for (const child of Object.values(value)) {
              collect(child);
            }
          }
        }
      };

      while (reader.remaining() > 0) {
        collect(reader.readAny());
      }

      if (colors.length > 0) {
        const seen = new Map<string, UnrealColor>();
        for (const color of colors) {
          const key = color.join(',');
          if (!seen.has(key)) {
            seen.set(key, color);
          }
        }
        return Array.from(seen.values());
      }
    } catch {
      // ignore palette parse errors
    }
  }
  return null;
}

function collectGridTransforms(
  archive: BrzArchive,
  global: ParsedGlobalData
): Map<number, GridTransform> {
  const transforms = new Map<number, GridTransform>();
  const entityChunkPattern = /^World\/0\/Entities\/Chunks\/(-?\d+)_(-?\d+)_(-?\d+)\.mps$/;
  for (const path of archive.listFiles()) {
    if (!entityChunkPattern.test(path)) continue;
    try {
      const entities = parseEntityChunk(archive.readFile(path), global);
      for (const entity of entities) {
        if (entity.typeName === 'Entity_DynamicBrickGrid') {
          transforms.set(entity.persistentIndex, {
            position: entity.position,
            rotation: entity.rotation,
          });
        }
      }
    } catch {
      // ignore malformed entity chunk files
    }
  }
  return transforms;
}

function gatherBricks(
  archive: BrzArchive,
  global: ParsedGlobalData,
  options: ReadOptions,
  gridTransforms: Map<number, GridTransform>,
  componentSchema: SchemaDefinition | null,
  componentDecoder: SchemaDecoder | null
): {
  bricks: IntermediateBrick[];
  assetNames: string[];
  componentDefinitions: Map<string, ComponentDefinitionInfo>;
  wires: Wire[];
  dynamicGrids: DynamicGridInfo[];
} {
  if (options.bricks === false) {
    return {
      bricks: [],
      assetNames: [],
      componentDefinitions: new Map(),
      wires: [],
      dynamicGrids: [],
    };
  }

  const chunkBaseIndex = new Map<string, number>();
  const chunkBrickCounts = new Map<string, number>();
  const gridBrickIndices = new Map<number, number[]>();
  const wires: Wire[] = [];
  const pendingRemoteWires: Array<{
    source: RemoteWireEndpoint;
    target: Wire['target'];
  }> = [];

  const chunkKey = (
    gridId: number,
    coords: { x: number; y: number; z: number }
  ) => `${gridId}:${coords.x}:${coords.y}:${coords.z}`;

  const chunkFiles = archive
    .listFiles()
    .map(path => {
      const match =
        /^World\/0\/Bricks\/Grids\/(\d+)\/Chunks\/(-?\d+)_(-?\d+)_(-?\d+)\.mps$/.exec(
          path
        );
      if (!match) return null;
      const gridId = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);
      const z = Number(match[4]);
      return { path, gridId, coords: { x, y, z } };
    })
    .filter(
      (entry): entry is {
        path: string;
        gridId: number;
        coords: { x: number; y: number; z: number };
      } => entry !== null
    );

  const bricks: IntermediateBrick[] = [];
  const componentDefinitions = new Map<string, ComponentDefinitionInfo>();
  for (const entry of chunkFiles) {
    try {
      const baseIndex = bricks.length;
      const chunkData = parseBrickChunk(archive.readFile(entry.path));
      const chunkBricks = convertChunkToBricks(chunkData, entry.coords, global);
      for (const brick of chunkBricks) {
        brick.gridId = entry.gridId;
        brick.localPosition = brick.position.slice() as Vector;
      }
      chunkBaseIndex.set(chunkKey(entry.gridId, entry.coords), baseIndex);
      chunkBrickCounts.set(chunkKey(entry.gridId, entry.coords), chunkBricks.length);
      if (componentSchema && componentDecoder) {
        const componentPath = `World/0/Bricks/Grids/${entry.gridId}/Components/${entry.coords.x}_${entry.coords.y}_${entry.coords.z}.mps`;
        if (archive.hasFile(componentPath)) {
          try {
            const parsed = parseComponentChunk(
              archive.readFile(componentPath),
              global,
              componentSchema,
              componentDecoder
            );
            for (const [typeName, definition] of parsed.definitions) {
              const existing = componentDefinitions.get(typeName);
              if (!existing) {
                componentDefinitions.set(typeName, {
                  version: definition.version,
                  propertyTypes: { ...definition.propertyTypes },
                });
              } else {
                existing.version = Math.max(existing.version, definition.version);
                for (const [propName, propType] of Object.entries(
                  definition.propertyTypes
                )) {
                  if (!(propName in existing.propertyTypes)) {
                    existing.propertyTypes[propName] = propType;
                  }
                }
              }
            }
            for (const instance of parsed.instances) {
              const localBrick = chunkBricks[instance.localBrickIndex];
              if (!localBrick) continue;
              if (!localBrick.components) {
                localBrick.components = {};
              }
              localBrick.components[instance.typeName] = instance.properties;
            }
          } catch {
            // ignore component parse errors for now
          }
        }
      }
      const wirePath = `World/0/Bricks/Grids/${entry.gridId}/Wires/${entry.coords.x}_${entry.coords.y}_${entry.coords.z}.mps`;
      if (archive.hasFile(wirePath)) {
        try {
          const parsedWires = parseWireChunk(archive.readFile(wirePath));
          for (const wire of parsedWires.local) {
            const sourceComponent =
              global.componentTypeNames[wire.source.componentTypeIndex] ??
              `Component_${wire.source.componentTypeIndex}`;
            const targetComponent =
              global.componentTypeNames[wire.target.componentTypeIndex] ??
              `Component_${wire.target.componentTypeIndex}`;
            const sourcePort =
              global.componentWirePortNames[wire.source.portIndex] ??
              `Port_${wire.source.portIndex}`;
            const targetPort =
              global.componentWirePortNames[wire.target.portIndex] ??
              `Port_${wire.target.portIndex}`;

            if (
              wire.source.brickIndex >= chunkBricks.length ||
              wire.target.brickIndex >= chunkBricks.length
            ) {
              continue;
            }

            wires.push({
              source: {
                brick_index: baseIndex + wire.source.brickIndex,
                component: sourceComponent,
                port: sourcePort,
              },
              target: {
                brick_index: baseIndex + wire.target.brickIndex,
                component: targetComponent,
                port: targetPort,
              },
            });
          }
          for (const wire of parsedWires.remote) {
            const targetComponent =
              global.componentTypeNames[wire.target.componentTypeIndex] ??
              `Component_${wire.target.componentTypeIndex}`;
            const targetPort =
              global.componentWirePortNames[wire.target.portIndex] ??
              `Port_${wire.target.portIndex}`;
            if (wire.target.brickIndex >= chunkBricks.length) {
              continue;
            }
            pendingRemoteWires.push({
              source: wire.source,
              target: {
                brick_index: baseIndex + wire.target.brickIndex,
                component: targetComponent,
                port: targetPort,
              },
            });
          }
        } catch {
          // ignore malformed wire chunks
        }
      }
      const transform = gridTransforms.get(entry.gridId);
      if (transform) {
        transformBricks(chunkBricks, transform);
      }
      const gridIndices =
        gridBrickIndices.get(entry.gridId) ?? [];
      for (let i = 0; i < chunkBricks.length; i++) {
        gridIndices.push(baseIndex + i);
      }
      gridBrickIndices.set(entry.gridId, gridIndices);
      bricks.push(...chunkBricks);
    } catch {
      // Ignore malformed chunks for now.
    }
  }

  const assetNames = [
    ...global.basicBrickAssets,
    ...global.proceduralBrickAssets,
  ];
  // Resolve remote wires once chunk indices are known.
  for (const wire of pendingRemoteWires) {
    const key = chunkKey(wire.source.gridPersistentIndex, wire.source.chunk);
    const base = chunkBaseIndex.get(key);
    const count = chunkBrickCounts.get(key) ?? 0;
    if (base === undefined) {
      continue;
    }
    if (wire.source.brickIndex >= count) {
      continue;
    }
    const componentName =
      global.componentTypeNames[wire.source.componentTypeIndex] ??
      `Component_${wire.source.componentTypeIndex}`;
    const portName =
      global.componentWirePortNames[wire.source.portIndex] ??
      `Port_${wire.source.portIndex}`;

    wires.push({
      source: {
        brick_index: base + wire.source.brickIndex,
        component: componentName,
        port: portName,
      },
      target: wire.target,
    });
  }

  const dynamicGrids: DynamicGridInfo[] = [];
  for (const [gridId, transform] of gridTransforms.entries()) {
    const indices = gridBrickIndices.get(gridId);
    if (!indices || indices.length === 0) continue;
    dynamicGrids.push({
      id: gridId,
      position: [...transform.position] as Vector,
      rotation: [...transform.rotation],
      brick_indices: [...indices],
      persistent_index: gridId,
    });
  }

  return { bricks, assetNames, componentDefinitions, wires, dynamicGrids };
}

export default function readBrz(
  rawBytes: Uint8Array,
  options: ReadOptions = {}
): BrzReadSaveObject {
  const archive = new BrzArchive(rawBytes);
  const globalData = parseGlobalData(archive.readFile('World/0/GlobalData.mps'));

  let owners: OwnerRecord[] = [];
  if (archive.hasFile('World/0/Owners.mps')) {
    owners = parseOwnerTable(archive.readFile('World/0/Owners.mps'));
  }

  const assetRefs = globalData.externalAssetReferences ?? [];
  const resolveAsset = (_type: string, index: number) =>
    assetRefs[index]?.assetName;

  let componentSchema: SchemaDefinition | null = null;
  let componentDecoder: SchemaDecoder | null = null;

  if (archive.hasFile('World/0/Bricks/ComponentsShared.schema')) {
    try {
      componentSchema = parseSchema(
        archive.readFile('World/0/Bricks/ComponentsShared.schema')
      );
      componentDecoder = new SchemaDecoder(componentSchema, {
        resolveAsset,
      });
    } catch {
      componentSchema = null;
      componentDecoder = null;
    }
  }

  const gridTransforms = collectGridTransforms(archive, globalData);
  const {
    bricks: intermediateBricks,
    assetNames,
    componentDefinitions,
    wires,
    dynamicGrids,
  } = gatherBricks(
    archive,
    globalData,
    options,
    gridTransforms,
    componentSchema,
    componentDecoder
  );

  const assetIndexMap = new Map<string, number>();
  const brickAssets: string[] = [];

  for (const name of assetNames) {
    if (!assetIndexMap.has(name)) {
      assetIndexMap.set(name, brickAssets.length);
      brickAssets.push(name);
    }
  }

  const ensureAsset = (name: string): number => {
    const existing = assetIndexMap.get(name);
    if (existing !== undefined) return existing;
    const index = brickAssets.length;
    brickAssets.push(name);
    assetIndexMap.set(name, index);
    return index;
  };

  const colors =
    tryReadPalette(archive) ?? collectUniqueColors(intermediateBricks);
  const bricks = buildWriteBricks(intermediateBricks, assetIndexMap, ensureAsset);
  const typeToIndices = new Map<string, number[]>();
  bricks.forEach((brick, index) => {
    const comps = brick.components ?? {};
    for (const typeName of Object.keys(comps)) {
      if (!typeToIndices.has(typeName)) {
        typeToIndices.set(typeName, []);
      }
      typeToIndices.get(typeName)!.push(index);
    }
  });

  const componentTypes = new Set<string>([
    ...componentDefinitions.keys(),
    ...typeToIndices.keys(),
  ]);
  const componentsRecord: Record<
    string,
    { version: number; properties: Record<string, string>; brick_indices: number[] }
  > = {};

  for (const typeName of componentTypes) {
    const definition = componentDefinitions.get(typeName);
    const brickIndices = typeToIndices.get(typeName) ?? [];
    if (!definition && brickIndices.length === 0) {
      continue;
    }
    componentsRecord[typeName] = {
      version: definition?.version ?? 1,
      properties: { ...(definition?.propertyTypes ?? {}) },
      brick_indices: brickIndices,
    };
  }

  const componentKeys = Object.keys(componentsRecord);
  const components =
    componentKeys.length > 0 ? componentsRecord : undefined;
  const materials = [...globalData.materialAssets];
  const physicalMaterials = extractPhysicalMaterials(globalData);

  const save: BrzReadSaveObject = {
    format: 'brz',
    game_version: undefined,
    map: undefined,
    description: undefined,
    author: undefined,
    host: undefined,
    mods: [],
    brick_assets: brickAssets,
    colors,
    materials,
    brick_owners: mapOwners(owners),
    physical_materials: physicalMaterials,
    bricks,
    components,
    wires: wires.length > 0 ? wires : undefined,
    dynamic_grids: dynamicGrids.length > 0 ? dynamicGrids : undefined,
    brick_count: bricks.length,
  };

  Object.assign(save, extractMeta(archive));

  return save;
}

export function offsetBrzSave(
  save: BrzReadSaveObject,
  delta: Vector
): BrzReadSaveObject {
  const [dx, dy, dz] = delta;
  const bricks = save.bricks.map(brick => ({
    ...brick,
    position: [
      brick.position[0] + dx,
      brick.position[1] + dy,
      brick.position[2] + dz,
    ] as Vector,
  }));

  const dynamicGrids = save.dynamic_grids
    ? save.dynamic_grids.map(grid => ({
        ...grid,
        position: [
          grid.position[0] + dx,
          grid.position[1] + dy,
          grid.position[2] + dz,
        ] as Vector,
      }))
    : undefined;

  return {
    ...save,
    bricks,
    dynamic_grids: dynamicGrids,
    brick_count: bricks.length,
  };
}
