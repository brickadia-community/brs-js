import read from './read';
import write from './write';
import * as utils from './utils';
import * as constants from './constants';
import * as types from './types';
import readBrz, { offsetBrzSave } from './brz/read';
import * as brzWorld from './brz/world';
import * as brzSchema from './brz/schema';
export * from './types';

// https://i.imgur.com/cv1fDWs.png
const brz = { read: readBrz, offsetSave: offsetBrzSave, world: brzWorld, schema: brzSchema };
const brs = { read, write, utils, constants, types, brz, offsetBrzSave };
export { read, write, utils, constants, types, brz, offsetBrzSave };
export default brs;

if (typeof window !== 'undefined') {
  (window as any).BRS = brs;
}
