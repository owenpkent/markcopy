// The Mocha entry point for the Restricted Mode run (see launch.mjs). It runs
// every *.suite.js beside it, a name the main run's *.test.js glob does not
// match, so these suites never run in a trusted workspace by accident.
import * as fs from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', timeout: 60000, color: false });
  for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.suite.js'))) {
    mocha.addFile(path.join(__dirname, file));
  }
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) =>
      failures ? reject(new Error(`${failures} test(s) failed.`)) : resolve(),
    );
  });
}
