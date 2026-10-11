import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
const read=p=>readFileSync(p,'utf8');
const manifest=JSON.parse(read('deploy/cloud/package.json'));
assert.deepEqual(Object.keys(manifest.dependencies).sort(),['postgres','zod']);
const lock=JSON.parse(read('deploy/cloud/package-lock.json'));
assert.deepEqual(Object.keys(lock.packages).sort(),['','node_modules/postgres','node_modules/zod']);
for(const name of readdirSync('cloud').filter(n=>n.endsWith('.ts'))){
 const source=read('cloud/'+name);
 for(const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g))assert(match[1].startsWith('./')||match[1].startsWith('node:')||['postgres','zod'].includes(match[1]),`${name}: unexpected import`);
}
assert(read('Dockerfile.cloud').includes('COPY deploy/cloud/package.json deploy/cloud/package-lock.json ./'));
assert(!read('Dockerfile.cloud').includes('COPY . .'));
assert(read('.dockerignore').startsWith('# Allowlist'));
assert.equal(JSON.parse(read('railway.json')).deploy.numReplicas,1);
console.log('Cloud package isolation passed');
