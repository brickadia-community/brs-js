# brs.js

Read and write Brickadia save files (.brs)

Currently supports save versions <= 4

**Warning:** __Unreal Engine uses numbers potentially larger than Javascript can handle.__

## Install

`npm install brs-js`

## Documentation and Usage

**Node:**

    const brs = require('brs-js');

**ES6:**

    import brs from 'brs-js';

**Web:**

Head: `<script src="https://cdn.jsdelivr.net/npm/brs-js/dist/dist.js"></script>`

Script: `window.BRS`

### Examples

Examples are available in the `examples/` directory. All `.js` examples are for node, `.html` are for web.

### Save Object

The Save Object is the input and output of this program. It represents the decoded/decompressed contents of the save.
Strings can be UCS-2 or UTF-8. UUIDs follow the spec. The `save_time` field is 8 bytes (Little Endian) instead of a long.
Unsigned ints, while unlikely, may overflow.

```javascript
{
  version: short,
  map: string,
  author: {id: uuid, name: string},
  description: string,
  save_time: UTC as 8 bytes,
  brick_count: int,
  mods: string array,
  brick_assets: [string],
    // --- See bottom of page for known bricks ---
  colors: [[byte, byte, byte, byte], ... ],
  materials: [string],
    // --- Known available materials
    // BMC_Ghost
    // BMC_Ghost_Fail
    // BMC_Plastic
    // BMC_Glow
    // BMC_Metallic
    // BMC_Hologram
  brick_owners: [{id: uuid, name: string}, ... ],
  bricks: [{
    asset_name_index: int,
    size: [uint, uint, uint],
      // must be [0, 0, 0] for all B_ prefixed brick_assets
      // must NOT be [0, 0, 0] for all PB_ prefixed brick_assets
      // 1x1 brick has size [5, 5, 6]
      // 1x1F plate has size [5, 5, 2]
    position: [int, int, int],
    direction: 0-5,
      // --- Directions (facing axis) ---
      // 0: X Positive
      // 1: X Negative
      // 2: Y Positive
      // 3: Y Negative
      // 4: Z Positive
      // 5: Z Negative
    rotation: 0-3,
      // --- Rotations (along the facing axis) ---
      // 0: 0 Deg
      // 1: 90 Deg
      // 2: 180 Deg
      // 3: 270 Deg
    collision: bool,
    visibility: bool,
    material_index: uint,
    color: uint or [byte, byte, byte, byte],
    owner_index: uint,
  }, ... ],
}
```

**Fields:** (optional fields during `brs.write(save)` will be set to default)

| field                       | type   | default                              | optional | description                      |
|-----------------------------|--------|--------------------------------------|----------|----------------------------------|
| version                     | short  | Latest Save Version                  | auto     | Save file version                |
| map                         | string | 'Unknown'                            | &#9745;  | Map where the save was generated |
| author.id                   | uuid   | 00000000-0000-0000-0000-000000000000 | &#9745;  | Save author UUID                 |
| author.name                 | string | 'Unknown'                            | &#9745;  | Save author name                 |
| description                 | string | '' (Empty String)                    | &#9745;  | Save author name                 |
| save_time                   | array  | [0, 0, 0, 0, 0, 0, 0, 0]             | &#9745;  | UTC in bytes of creation time    |
| brick_count                 | int    | Number of bricks in `bricks`         | auto     | Number of bricks in save         |
| mods                        | array  | []                                   | &#9745;  | In game mods required for load   |
| brick_assets                | array  | ['PB_DefaultBrick']                  | &#9745;  | List of brick assets             |
| colors                      | array  | []                                   | &#9745;  | List of colorset colors          |
| materials                   | array  | ['BMC_Plastic']                      | &#9745;  | List of used materials           |
| brick_owners                | array  | [{}]                                 | &#9745;  | Brick owner list                 |
| brick_owners[].id           | uuid   | 00000000-0000-0000-0000-000000000000 | &#9745;  | Brick owner list user uuid       |
| brick_owners[].name         | string | 'Unknown'                            | &#9745;  | Brick owner list user name       |
| bricks                      | array  |                                      |          | List of bricks in the save       |
| bricks[].asset_name_index   | int    | 0 (0 indexed)                        | &#9745;  | Index of asset in `brick_assets` |
| bricks[].size               | array  |                                      |          | Brick size                       |
| bricks[].position           | array  |                                      |          | Brick position                   |
| bricks[].direction          | int    | 4 (Positive Z, Upward)               | &#9745;  | Brick axis / facing direction    |
| bricks[].rotation           | int    | 0 (0 degrees)                        | &#9745;  | Brick rotation on axis           |
| bricks[].collision          | bool   | true                                 | &#9745;  | Brick has collision with players |
| bricks[].visibility         | bool   | true                                 | &#9745;  | Brick renders to players         |
| bricks[].material_index     | int    | 0 (0 indexed)                        | &#9745;  | Index of material in `materials` |
| bricks[].color *(colorset)* | int    | [255, 255, 255, 255]                 | &#9745;  | Index of color in `colors`       |
| bricks[].color *(rgba)*     | array  | [255, 255, 255, 255]                 | &#9745;  | Color in RGBA Bytes              |
| bricks[].owner_index        | int    | 1 (1 indexed)                        | &#9745;  | Index of owner in `brick_owners` |

### Function `brs.read(buffer)`

**Returns**: Save Object

In node, the buffer can be obtained from `fs.readFile` without an encoding specified. In web, the buffer can be obtained via `File.arrayBuffer()`. Be sure to resolve promises where necessary.

| parameter   | type                | description              |
|-------------|---------------------|--------------------------|
| `buffer`    | Uint8Array / Buffer | Input bytes to be parsed |

### Function `brs.write(saveObj)`

**Returns**: Uint8Array

In node, the buffer can be saved with from `fs.writeFile(fileName, buffer)`. In web, the buffer can be made into a `new Blob([buffer])`, and can be downloaded with an `<a download>` with `href` as `URL.createObjectURL(blob)`.

| parameter   | type        | description                            |
|-------------|-------------|----------------------------------------|
| `saveObj`   | Save Object | Save Object to be turned into a buffer |

### Brick Assets

Notes:

  - Size must be [0, 0, 0] for bricks using non-procedural brick assets
  - Size must NOT be [0, 0, 0] for bricks using procedural brick assets
  - 1x1 brick has size [5, 5, 6] and 'PB_DefaultBrick' brick asset
  - 1x1F plate has size [5, 5, 2] and 'PB_DefaultBrick' brick asset


| name | procedural |
|------|------------|
| PB_DefaultBrick | &#9745; |
| PB_DefaultRamp | &#9745; |
| PB_DefaultRampCrest | &#9745; |
| PB_DefaultRampCrestCorner | &#9745; |
| PB_DefaultRampCrestEnd | &#9745; |
| PB_DefaultRampInnerCornerInverted | &#9745; |
| PB_DefaultRampInverted | &#9745; |
| PB_DefaultSideWedge | &#9745; |
| PB_DefaultTile | &#9745; |
| PB_DefaultWedge | &#9745; |
| B_1x1_Brick_Side | |
| B_1x1_Brick_Side_Lip | |
| B_1x1_Cone | |
| B_1x1_Round | |
| B_1x1F_Octo | |
| B_1x1F_Round | |
| B_1x2_Overhang | |
| B_1x2f_Plate_Center | |
| B_1x2f_Plate_Center_Inv | |
| B_1x4_Brick_Side | |
| B_1x_Octo | |
| B_1x_Octo_90Deg | |
| B_1x_Octo_90Deg_Inv | |
| B_1x_Octo_T | |
| B_1x_Octo_T_Inv | |
| B_2x1_Slipper | |
| B_2x2_Cone | |
| B_2x2_Corner | |
| B_2x2_Overhang | |
| B_2x2_Round | |
| B_2x2_Slipper | |
| B_2x2F_Octo | |
| B_2x2F_Octo_Converter | |
| B_2x2F_Octo_Converter_Inv | |
| B_2x2f_Plate_Center | |
| B_2x2f_Plate_Center_Inv | |
| B_2x2F_Round | |
| B_2x4_Door_Frame | |
| B_2x_Cube_Side | |
| B_2x_Octo | |
| B_2x_Octo_90Deg | |
| B_2x_Octo_90Deg_Inv | |
| B_2x_Octo_Cone | |
| B_2x_Octo_T | |
| B_2x_Octo_T_Inv | |
| B_4x4_Round | |
| B_8x8_Lattice_Plate | |
| B_Bishop | |
| B_Bone | |
| B_BoneStraight | |
| B_Branch | |
| B_Bush | |
| B_Cauldron | |
| B_Chalice | |
| B_CheckPoint | |
| B_Coffin | |
| B_Coffin_Lid | |
| B_Fern | |
| B_Flame | |
| B_Flower | |
| B_Gravestone | |
| B_GoalPoint | |
| B_Handle | |
| B_Hedge_1x1 | |
| B_Hedge_1x1_Corner | |
| B_Hedge_1x2 | |
| B_Hedge_1x4 | |
| B_Inverted_Cone | |
| B_Jar | |
| B_King | |
| B_Knight | |
| B_Ladder | |
| B_Pawn | |
| B_Picket_Fence | |
| B_Pine_Tree | |
| B_Pumpkin | |
| B_Pumpkin_Carved | |
| B_Queen | |
| B_Rook | |
| B_Sausage | |
| B_Small_Flower | |
| B_SpawnPoint | |
| B_Swirl_Plate | |
| B_Turkey_Body | |
| B_Turkey_Leg | |

## Development

NPM Scripts (`npm run <cmd>`)

| name  | description                                              |
|-------|----------------------------------------------------------|
| build | Build library in development mode                        |
| watch | Auto-build library in development mode when files change |
| dist  | Build library in production mode                         |
| test  | Run tests                                                |

