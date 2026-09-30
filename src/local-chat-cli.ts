#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { LocalChatContinuation, LocalChatRouteSchema } from './local-chat-continuation.js';
import { installedDesktopBridge } from './local-chat-adapter.js';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true,
    options: { config: { type: 'string' }, file: { type: 'string' }, key: { type: 'string' },
      'db-path': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('local-chat-event <enqueue|dispatch|recover|settle|cancel|status> --config <operator.json> [--file event.json|--key deliveryKey] [--db-path private.sqlite]');
    return;
  }
  if (!values.config || positionals.length !== 1) throw new Error('one command and --config required');
  const command = positionals[0];
  if (!['enqueue', 'dispatch', 'recover', 'settle', 'cancel', 'status'].includes(command!)) throw new Error('unknown_command');
  const config = z.object({ version: z.literal(1), desktopBridgeRoot: z.string().min(1),
    stateDirectory: z.string().min(1), routes: z.array(LocalChatRouteSchema) }).strict()
    .parse(JSON.parse(fs.readFileSync(values.config, 'utf8')));
  if (!path.isAbsolute(config.stateDirectory)) throw new Error('state_directory_must_be_absolute');
  const driver = new LocalChatContinuation(values['db-path'] ?? path.join(config.stateDirectory, 'local-events.sqlite'),
    config.routes, installedDesktopBridge(config.desktopBridgeRoot, config.stateDirectory));
  try {
    let result: unknown;
    if (command === 'enqueue') {
      if (!values.file || values.key) throw new Error('enqueue requires --file only');
      result = driver.enqueue(JSON.parse(fs.readFileSync(values.file, 'utf8')));
    } else if (command === 'status') result = values.key ? driver.get(values.key) : driver.list();
    else {
      if (!values.key || values.file) throw new Error('command requires --key only');
      result = command === 'dispatch' ? await driver.dispatch(values.key)
        : command === 'recover' ? await driver.recover(values.key)
        : command === 'settle' ? await driver.settle(values.key) : driver.cancelPending(values.key);
    }
    console.log(JSON.stringify(result));
  } finally { driver.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
