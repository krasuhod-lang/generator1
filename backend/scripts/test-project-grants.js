'use strict';

/**
 * test-project-grants.js — юнит-тесты слоя выдачи доступов к проектам.
 *
 * Запуск:  node backend/scripts/test-project-grants.js
 *
 * Тестируем чистые функции (canAct, normalizeRole, normalizeScopes,
 * forcedClientMode, buildOwnerAccess/buildGrantAccess) и DB-функции с
 * подставленным in-memory моком dbInstance (без реального Postgres).
 */

const assert = require('assert');
const {
  ROLES, SCOPES, DEFAULT_SCOPES,
  normalizeRole, normalizeScopes,
  buildOwnerAccess, buildGrantAccess,
  canAct, forcedClientMode,
  loadGrant, loadAccessibleProject, listAccessibleProjects,
  upsertGrant, revokeGrant, listGrants,
} = require('../src/services/projects/projectGrants');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}
async function asyncTest(name, fn) {
  total += 1;
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// ── Фейковая БД ─────────────────────────────────────────────────────
function makeFakeDb() {
  const state = {
    projects: new Map(),         // id → { id, user_id, name }
    grants: new Map(),           // id → grant row
    events: [],
    nextGrantId: 1,
  };

  function _now() { return new Date(); }
  function _active(g) {
    return !g.revoked_at && (!g.expires_at || g.expires_at > _now());
  }

  const db = {
    state,
    async query(sql, params = []) {
      const norm = sql.replace(/\s+/g, ' ').trim();

      // loadGrant
      if (norm.startsWith('SELECT id, project_id, user_id, role, scopes, granted_by, granted_at, expires_at FROM project_grants')) {
        const [projectId, userId] = params;
        const rows = [...state.grants.values()].filter(
          (g) => g.project_id === projectId && g.user_id === userId && _active(g),
        );
        return { rows };
      }

      // loadAccessibleProject (single project + access check)
      if (norm.startsWith('SELECT p.*, (p.user_id = $2) AS is_owner FROM projects p WHERE p.id = $1')) {
        const [projectId, userId] = params;
        const p = state.projects.get(projectId);
        if (!p) return { rows: [] };
        if (p.user_id === userId) return { rows: [{ ...p, is_owner: true }] };
        const grant = [...state.grants.values()].find(
          (g) => g.project_id === projectId && g.user_id === userId && _active(g),
        );
        if (!grant) return { rows: [] };
        return { rows: [{ ...p, is_owner: false }] };
      }

      // listAccessibleProjects: own UNION ALL granted
      if (norm.includes("UNION ALL") && norm.includes('access_role')) {
        const [userId] = params;
        const ownRows = [...state.projects.values()]
          .filter((p) => p.user_id === userId)
          .map((p) => ({ ...p, access_role: 'owner', access_scopes: DEFAULT_SCOPES, access_is_owner: true }));
        const grantedRows = [...state.grants.values()]
          .filter((g) => g.user_id === userId && _active(g))
          .map((g) => {
            const p = state.projects.get(g.project_id);
            if (!p || p.user_id === userId) return null;
            return { ...p, access_role: g.role, access_scopes: g.scopes, access_is_owner: false };
          })
          .filter(Boolean);
        return { rows: [...ownRows, ...grantedRows] };
      }

      // listGrants (project)
      if (norm.startsWith('SELECT g.id, g.project_id, g.user_id, g.role, g.scopes')) {
        const [projectId] = params;
        const rows = [...state.grants.values()]
          .filter((g) => g.project_id === projectId)
          .map((g) => ({ ...g, user_email: `u${g.user_id}@x`, user_name: `u${g.user_id}` }));
        return { rows };
      }

      // upsertGrant: SELECT user_id FROM projects
      if (norm.startsWith('SELECT user_id FROM projects WHERE id = $1')) {
        const [projectId] = params;
        const p = state.projects.get(projectId);
        return { rows: p ? [{ user_id: p.user_id }] : [] };
      }

      // upsertGrant UPDATE
      if (norm.startsWith('UPDATE project_grants SET role = $1')) {
        const [role, scopesJson, expiresAt, note, id] = params;
        const g = state.grants.get(id);
        if (!g) return { rows: [] };
        g.role = role;
        g.scopes = JSON.parse(scopesJson);
        g.expires_at = expiresAt;
        if (note != null) g.note = note;
        return { rows: [{ ...g }] };
      }

      // upsertGrant INSERT
      if (norm.startsWith('INSERT INTO project_grants')) {
        const [projectId, userId, role, scopesJson, grantedBy, expiresAt, note] = params;
        const id = `g${state.nextGrantId++}`;
        const row = {
          id, project_id: projectId, user_id: userId, role,
          scopes: JSON.parse(scopesJson), granted_by: grantedBy,
          granted_at: _now(), expires_at: expiresAt, revoked_at: null, revoked_by: null, note,
        };
        state.grants.set(id, row);
        return { rows: [{ ...row }] };
      }

      // revokeGrant
      if (norm.startsWith('UPDATE project_grants SET revoked_at = NOW()')) {
        const [id, actor] = params;
        const g = state.grants.get(id);
        if (!g || g.revoked_at) return { rows: [] };
        g.revoked_at = _now();
        g.revoked_by = actor;
        return { rows: [{ ...g }] };
      }

      // event log insert — игнорируем (no-op).
      if (norm.startsWith('INSERT INTO project_grant_events')) {
        state.events.push(params);
        return { rows: [] };
      }

      throw new Error('Unmatched fake-db query: ' + norm.slice(0, 80));
    },
  };
  return db;
}

// ── Чистые функции ─────────────────────────────────────────────────
console.log('── normalizeRole ───────────────────────────────');
test('valid roles', () => {
  for (const r of ROLES) assert.strictEqual(normalizeRole(r), r);
  assert.strictEqual(normalizeRole('VIEWER'), 'viewer');
});
test('invalid role → null', () => {
  assert.strictEqual(normalizeRole('owner'), null);
  assert.strictEqual(normalizeRole(''), null);
  assert.strictEqual(normalizeRole(null), null);
});

console.log('\n── normalizeScopes ─────────────────────────────');
test('valid scopes unique', () => {
  assert.deepStrictEqual(normalizeScopes(['project', 'reports']), ['project', 'reports']);
});
test('dedup + lowercase', () => {
  assert.deepStrictEqual(normalizeScopes(['Project', 'project', 'analyses']), ['project', 'analyses']);
});
test('filters unknown', () => {
  assert.deepStrictEqual(normalizeScopes(['project', 'xxx']), ['project']);
});
test('empty / invalid → null', () => {
  assert.strictEqual(normalizeScopes([]), null);
  assert.strictEqual(normalizeScopes(['xxx']), null);
  assert.strictEqual(normalizeScopes(null), null);
});

console.log('\n── canAct ──────────────────────────────────────');
const owner   = buildOwnerAccess();
const viewer  = buildGrantAccess({ id: 'g1', role: 'viewer',  scopes: ['project', 'reports'] });
const analyst = buildGrantAccess({ id: 'g2', role: 'analyst', scopes: ['project', 'analyses', 'reports'] });
const manager = buildGrantAccess({ id: 'g3', role: 'manager', scopes: ['analyses'] });

test('owner может всё', () => {
  for (const a of ['read', 'write', 'run', 'delete', 'admin']) {
    assert.strictEqual(canAct(owner, a, 'project'), true);
  }
});
test('viewer — только read, scoped', () => {
  assert.strictEqual(canAct(viewer, 'read', 'project'),  true);
  assert.strictEqual(canAct(viewer, 'read', 'reports'),  true);
  assert.strictEqual(canAct(viewer, 'read', 'analyses'), false, 'нет scope analyses');
  assert.strictEqual(canAct(viewer, 'write', 'reports'), false);
  assert.strictEqual(canAct(viewer, 'run',   'analyses'), false);
});
test('analyst — read+write, не run/delete', () => {
  assert.strictEqual(canAct(analyst, 'read', 'analyses'), true);
  assert.strictEqual(canAct(analyst, 'write', 'reports'), true);
  assert.strictEqual(canAct(analyst, 'run',   'analyses'), false);
  assert.strictEqual(canAct(analyst, 'delete'), false);
  assert.strictEqual(canAct(analyst, 'admin'), false);
});
test('manager — read+write+run, не delete/admin', () => {
  assert.strictEqual(canAct(manager, 'read', 'analyses'), true);
  assert.strictEqual(canAct(manager, 'run',  'analyses'), true);
  assert.strictEqual(canAct(manager, 'run',  'reports'),  false, 'нет scope reports');
  assert.strictEqual(canAct(manager, 'delete'), false);
});
test('canAct без scope-аргумента не проверяет scope', () => {
  assert.strictEqual(canAct(viewer, 'read'), true);
  assert.strictEqual(canAct(analyst, 'write'), true);
});
test('canAct(null|undef) → false', () => {
  assert.strictEqual(canAct(null, 'read', 'project'), false);
  assert.strictEqual(canAct(undefined, 'read'), false);
});

console.log('\n── forcedClientMode ────────────────────────────');
test('viewer → client; analyst/manager/owner → null', () => {
  assert.strictEqual(forcedClientMode(viewer),  'client');
  assert.strictEqual(forcedClientMode(analyst), null);
  assert.strictEqual(forcedClientMode(manager), null);
  assert.strictEqual(forcedClientMode(owner),   null);
});

// ── DB-функции на моке ─────────────────────────────────────────────
console.log('\n── DB layer (fake db) ──────────────────────────');
(async () => {
  await asyncTest('upsertGrant создаёт грант, loadGrant видит активный', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    const { grant, action } = await upsertGrant({
      projectId: 'p1', userId: 'u1', role: 'viewer',
      scopes: ['reports'], grantedBy: 'admin1',
    }, db);
    assert.strictEqual(action, 'created');
    assert.strictEqual(grant.role, 'viewer');
    assert.deepStrictEqual(grant.scopes, ['reports']);
    const fresh = await loadGrant('p1', 'u1', db);
    assert.ok(fresh);
    assert.strictEqual(fresh.role, 'viewer');
  });

  await asyncTest('повторный upsertGrant → action=updated, новые scopes', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    await upsertGrant({ projectId: 'p1', userId: 'u1', role: 'viewer', scopes: ['reports'], grantedBy: 'admin1' }, db);
    const { action, grant } = await upsertGrant({
      projectId: 'p1', userId: 'u1', role: 'manager', scopes: ['analyses', 'reports'], grantedBy: 'admin1',
    }, db);
    assert.strictEqual(action, 'updated');
    assert.strictEqual(grant.role, 'manager');
    assert.deepStrictEqual(grant.scopes, ['analyses', 'reports']);
    assert.strictEqual(db.state.grants.size, 1, 'один грант в таблице');
  });

  await asyncTest('upsertGrant запрещает выдачу владельцу', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    await assert.rejects(
      () => upsertGrant({ projectId: 'p1', userId: 'owner1', role: 'viewer', scopes: ['reports'] }, db),
      /owner/,
    );
  });

  await asyncTest('upsertGrant отвергает невалидную роль', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    await assert.rejects(
      () => upsertGrant({ projectId: 'p1', userId: 'u1', role: 'super-root', scopes: ['reports'] }, db),
      /role/,
    );
  });

  await asyncTest('revokeGrant делает loadGrant → null', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    const { grant } = await upsertGrant({ projectId: 'p1', userId: 'u1', role: 'viewer', scopes: ['reports'] }, db);
    await revokeGrant(grant.id, 'admin1', db);
    assert.strictEqual(await loadGrant('p1', 'u1', db), null);
  });

  await asyncTest('expired grant игнорируется loadGrant', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    const past = new Date(Date.now() - 86400000);
    await upsertGrant({ projectId: 'p1', userId: 'u1', role: 'viewer', scopes: ['reports'], expiresAt: past }, db);
    assert.strictEqual(await loadGrant('p1', 'u1', db), null);
  });

  await asyncTest('loadAccessibleProject: владелец → owner-access', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1', name: 'P1' });
    const r = await loadAccessibleProject('p1', 'owner1', db);
    assert.ok(r);
    assert.strictEqual(r.access.role, 'owner');
    assert.strictEqual(r.access.isOwner, true);
  });

  await asyncTest('loadAccessibleProject: получатель гранта → grant-access', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1', name: 'P1' });
    await upsertGrant({ projectId: 'p1', userId: 'u1', role: 'analyst', scopes: ['analyses'] }, db);
    const r = await loadAccessibleProject('p1', 'u1', db);
    assert.ok(r);
    assert.strictEqual(r.access.role, 'analyst');
    assert.deepStrictEqual(r.access.scopes, ['analyses']);
    assert.strictEqual(r.access.isOwner, false);
  });

  await asyncTest('loadAccessibleProject: посторонний → null', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    assert.strictEqual(await loadAccessibleProject('p1', 'stranger', db), null);
  });

  await asyncTest('listAccessibleProjects → own + granted (с access_role)', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'me',   name: 'mine', created_at: new Date(2) });
    db.state.projects.set('p2', { id: 'p2', user_id: 'other', name: 'shared', created_at: new Date(1) });
    await upsertGrant({ projectId: 'p2', userId: 'me', role: 'viewer', scopes: ['reports'] }, db);
    const rows = await listAccessibleProjects('me', 'id, name, created_at', db);
    assert.strictEqual(rows.length, 2);
    const own = rows.find((r) => r.id === 'p1');
    const shared = rows.find((r) => r.id === 'p2');
    assert.strictEqual(own.access_role, 'owner');
    assert.strictEqual(own.access_is_owner, true);
    assert.strictEqual(shared.access_role, 'viewer');
    assert.strictEqual(shared.access_is_owner, false);
  });

  await asyncTest('listGrants возвращает и активные, и revoked для аудита', async () => {
    const db = makeFakeDb();
    db.state.projects.set('p1', { id: 'p1', user_id: 'owner1' });
    const { grant: g1 } = await upsertGrant({ projectId: 'p1', userId: 'u1', role: 'viewer', scopes: ['reports'] }, db);
    await revokeGrant(g1.id, 'admin1', db);
    await upsertGrant({ projectId: 'p1', userId: 'u2', role: 'analyst', scopes: ['analyses'] }, db);
    const rows = await listGrants('p1', { includeRevoked: true }, db);
    assert.strictEqual(rows.length, 2);
  });

  console.log(`\nИтого: ${total - failed}/${total} тестов прошли.`);
  if (failed > 0) process.exit(1);
})();
