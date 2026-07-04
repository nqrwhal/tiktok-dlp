import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { REST, Routes } from 'discord.js';
import { commandJson } from '../src/discord/commands.js';
import { registerCommands } from '../src/discord/register-commands.js';

test('exports the expected slash command manifest', () => {
  assert.equal(commandJson.length, 4);

  const [download, watch, status, history] = commandJson;
  const downloadOptions = download.options ?? [];
  const watchOptions = watch.options ?? [];

  assert.equal(download.name, 'download');
  assert.deepEqual(downloadOptions.map((option) => option.name), ['url', 'delivery']);
  assert.equal(downloadOptions[0].required, true);
  assert.equal(downloadOptions[1].required, false);
  assert.deepEqual((downloadOptions[1].choices ?? []).map((choice) => choice.name), ['auto', 'file', 'link']);

  assert.equal(watch.name, 'watch');
  assert.deepEqual(watchOptions.map((option) => option.name), ['add', 'remove', 'list', 'run']);
  assert.deepEqual((watchOptions[0].options ?? []).map((option) => option.name), ['username']);
  assert.equal((watchOptions[0].options ?? [])[0].required, true);
  assert.deepEqual((watchOptions[1].options ?? []).map((option) => option.name), ['username']);
  assert.equal((watchOptions[1].options ?? [])[0].required, true);
  assert.deepEqual(watchOptions[2].options ?? [], []);
  assert.deepEqual((watchOptions[3].options ?? []).map((option) => option.name), ['username']);
  assert.equal((watchOptions[3].options ?? [])[0].required, true);

  assert.equal(status.name, 'status');
  assert.deepEqual(status.options ?? [], []);

  assert.equal(history.name, 'history');
  assert.deepEqual(history.options ?? [], []);
});

test('registerCommands uses guild command registration with the manifest body', async () => {
  const putCalls = [];

  mock.method(REST.prototype, 'put', async function put(route, body) {
    putCalls.push({ route, body });
    return { ok: true };
  });

  try {
    const result = await registerCommands({
      discordToken: 'token',
      discordClientId: 'app-123',
      discordGuildId: 'guild-456',
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(putCalls.length, 1);
    assert.equal(putCalls[0].route, Routes.applicationGuildCommands('app-123', 'guild-456'));
    assert.deepEqual(putCalls[0].body, { body: commandJson });
  } finally {
    mock.restoreAll();
  }
});
