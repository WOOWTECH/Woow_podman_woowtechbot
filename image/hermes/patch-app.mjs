// image/hermes/patch-app.mjs DIR: do not offer a Hermes that nobody has set up yet.
//
// OpenMausBot offers "Hermes default (config)" as soon as the hermes program exists. With Hermes in
// the image that is always, so a new service's default bot would follow a Hermes without a model and
// fail. This changes the one condition so that Hermes' config.yaml must name a model first: the PaaS
// image and the HA add-on (from 0.1.7-rc.15) build the same change from source (patch 0014). Here the
// base image is already compiled and pinned by digest, so the change is made to its exact text, and
// the build stops when that text is not there exactly once. Goes away with a base that has it.
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['index.js', 'openmausbot.js', 'pair-cli.js', 'server/drivers/acp/hermes.js'];
const CONDITION = /!hermesUsesProbedProvider\(env\)(\s*)&&(\s*)hermesInstalled\(cli\)/g;
const READ = /hermesConfigDefault\((\w+)\((\w+)\(dir,\s*"config\.yaml"\),\s*"utf8"\)\)/;
const ANCHOR = /function hermesInstalled\(/g;

export function patch(source) {
  if (source.includes('hermesNamesModel')) throw new Error('already patched');
  const count = expression => [...source.matchAll(expression)].length;
  if (count(CONDITION) !== 1 || count(ANCHOR) !== 1) throw new Error('the expected code is not there exactly once');
  const read = source.match(READ);
  if (!read) throw new Error('the config.yaml reader is not there');
  const [, readFile, join] = read;
  return source
    .replace(ANCHOR, 'function hermesNamesModel(env){try{return hermesConfigDefault(' +
      `${readFile}(${join}(env.HERMES_HOME||harnessHome("hermes",env),"config.yaml"),"utf8"))!==null}catch{return false}}\n$&`)
    .replace(CONDITION, (condition, before, after) => `${condition}${before}&&${after}hermesNamesModel(env)`);
}

if (process.argv[2]) {
  for (const name of FILES) {
    const file = path.join(process.argv[2], name);
    const { mode } = fs.statSync(file);
    try { fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8')), { mode }); } catch (error) {
      console.error(`patch-app: ${name}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`patch-app: ${FILES.length} files`);
}
