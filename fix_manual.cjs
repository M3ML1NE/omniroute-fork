const fs = require('fs');

function fix(file, replaces) {
  let content = fs.readFileSync(file, 'utf8');
  for (const [find, replace] of replaces) {
    content = content.replace(find, replace);
  }
  fs.writeFileSync(file, content);
}

fix('/root/omniroute-fork/open-sse/services/accountFallback.ts', [
  [/const circuits = getAllCircuitBreakers\(\)/g, 'const circuits = await getAllCircuitBreakers()']
]);

fix('/root/omniroute-fork/src/lib/db/apiKeyGroups.ts', [
  [/const groupPermissions = getGroupModelPermissions\(id\);/g, 'const groupPermissions = await getGroupModelPermissions(id);'],
  [/const existingGroup = getGroup\(id\);/g, 'const existingGroup = await getGroup(id);'],
  [/const perms = groupPermissions.find\(/g, 'const perms = groupPermissions.find('], // wait, if it's awaited above, this should be fine
  [/if \(allGroups\.length === 0\)/g, 'if ((await allGroups).length === 0)'],
  [/allGroups\.map\(/g, '(await allGroups).map(']
]);

fix('/root/omniroute-fork/src/lib/db/apiKeys.ts', [
  [/const allowed = checkModelAccess\(apiKeyId, targetModelId\);/g, 'const allowed = await checkModelAccess(apiKeyId, targetModelId);']
]);

fix('/root/omniroute-fork/src/lib/db/batches.ts', [
  [/afterBatch\.createdAt/g, '(await afterBatch).createdAt'],
  [/const batch = getBatch\(batchId\);/g, 'const batch = await getBatch(batchId);'],
  [/batch\.inputFileId/g, '(await batch).inputFileId'],
  [/batch\.outputFileId/g, '(await batch).outputFileId'],
  [/batch\.errorFileId/g, '(await batch).errorFileId'],
  [/if \(!hasActiveBatches\(\)\) \{/g, 'if (!(await hasActiveBatches())) {']
]);

fix('/root/omniroute-fork/src/lib/db/compressionCombos.ts', [
  [/return rows\.map\(/g, 'return (await rows).map('],
  [/const combo = getCompressionCombo\(id\);/g, 'const combo = await getCompressionCombo(id);'],
  [/combo\.isDefault/g, '(await combo).isDefault']
]);

fix('/root/omniroute-fork/src/lib/db/evals.ts', [
  [/const runs = getSuiteRuns\(suiteId, 1\);/g, 'const runs = await getSuiteRuns(suiteId, 1);'],
  [/for \(const run of runs\)/g, 'for (const run of await runs)'],
  [/const suiteMatch = suites\.find\(/g, 'const suiteMatch = (await suites).find(']
]);

fix('/root/omniroute-fork/src/lib/db/files.ts', [
  [/file\.createdAt/g, '(await file).createdAt'],
]);

fix('/root/omniroute-fork/src/lib/db/freeProxies.ts', [
  [/if \(proxyId\)/g, 'if (await proxyId)']
]);

fix('/root/omniroute-fork/src/lib/db/gamification.ts', [
  [/const todayCredits = getCreditsAwardedToday\(\);/g, 'const todayCredits = await getCreditsAwardedToday();'],
  [/if \(todayCredits < MAX_DAILY_CREDITS\)/g, 'if (await todayCredits < MAX_DAILY_CREDITS)'],
  [/const result = addCredits\(REWARD_EASTER_EGG, "Easter Egg"\);/g, 'const result = await addCredits(REWARD_EASTER_EGG, "Easter Egg");']
]);

fix('/root/omniroute-fork/src/lib/db/middleware.ts', [
  [/const config = getHookConfig\(hookId\);/g, 'const config = await getHookConfig(hookId);'],
  [/updateHookConfig\(hookId, \{/g, 'await updateHookConfig(hookId, {']
]);

fix('/root/omniroute-fork/src/lib/db/plugins.ts', [
  [/const row = getPlugin\(id\);/g, 'const row = await getPlugin(id);']
]);

fix('/root/omniroute-fork/src/lib/db/proxies.ts', [
  [/const legacyClearStatus = clearLegacyProxyForAssignment\(db, assignment\);/g, 'const legacyClearStatus = await clearLegacyProxyForAssignment(db, assignment);'],
  [/proxy: getProxyRowByIdOrThrow\(db, id, \{ includeSecrets: false \}\),/g, 'proxy: await getProxyRowByIdOrThrow(db, id, { includeSecrets: false }),'],
  [/assignment: getAssignmentRow\(db, assignment\.scope, assignment\.scopeId\),/g, 'assignment: await getAssignmentRow(db, assignment.scope, assignment.scopeId),'],
  [/const existing = getProxyRowById\(db, id, \{ includeSecrets: true \}\);/g, 'const existing = await getProxyRowById(db, id, { includeSecrets: true });'],
  [/return rows\.map\(/g, 'return (await rows).map(']
]);

fix('/root/omniroute-fork/src/lib/db/webhooks.ts', [
  [/const webhook = getWebhook\(id\);/g, 'const webhook = await getWebhook(id);']
]);

fix('/root/omniroute-fork/src/lib/modelsDevSync.ts', [
  [/for \(const row of rows\)/g, 'for (const row of await rows)']
]);

console.log('Applied manual fixes');
