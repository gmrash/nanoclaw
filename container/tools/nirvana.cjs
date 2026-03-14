// NirvanaHQ CLI — task management for NanoClaw agents
// Usage: nirvana <command> [args]

const https = require('https');
const crypto = require('crypto');

const API_URL = 'https://api.nirvanahq.com/';
const APP_ID = 'nanoclaw';
const APP_VERSION = '1.0.0';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function request(method, params = {}, body = null) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      api: body ? 'json' : 'rest',
      method,
      requestid: crypto.randomUUID(),
      clienttime: Math.floor(Date.now() / 1000).toString(),
      appid: APP_ID,
      appversion: APP_VERSION,
      ...params,
    });
    const url = `${API_URL}?${qs}`;
    const opts = {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    };
    const req = https.request(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error(`Invalid response: ${Buffer.concat(chunks).toString()}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function authPost() {
  return new Promise((resolve, reject) => {
    const user = process.env.NIRVANA_USER;
    const pass = process.env.NIRVANA_PASS;
    if (!user || !pass) {
      reject(new Error('NIRVANA_USER and NIRVANA_PASS must be set'));
      return;
    }
    const formData = `method=auth.new&u=${encodeURIComponent(user)}&p=${md5(pass)}`;
    const req = https.request({
      hostname: 'api.nirvanahq.com',
      path: '/?api=rest',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (!data.results?.[0]?.auth?.token) {
            reject(new Error(`Auth failed: ${JSON.stringify(data)}`));
            return;
          }
          resolve(data.results[0].auth.token);
        } catch {
          reject(new Error('Invalid auth response'));
        }
      });
    });
    req.on('error', reject);
    req.write(formData);
    req.end();
  });
}

async function auth() {
  return authPost();
}

const STATES = {
  0: 'inbox', 1: 'next', 2: 'waiting', 3: 'scheduled',
  4: 'someday', 5: 'later', 6: 'trashed', 7: 'done',
  8: 'deleted', 9: 'recurring', 11: 'project',
};
const STATE_NAMES = Object.fromEntries(
  Object.entries(STATES).map(([k, v]) => [v, parseInt(k)])
);

function formatTask(t) {
  const state = STATES[t.state] || `state:${t.state}`;
  const due = t.duedate ? ` due:${t.duedate}` : '';
  const start = t.startdate ? ` start:${t.startdate}` : '';
  const project = t.ps ? ` project:${t.ps}` : '';
  const note = t.note ? `\n    Note: ${t.note.slice(0, 200)}` : '';
  return `  ${t.id.slice(0, 8)} | ${state.padEnd(10)} | ${t.name}${due}${start}${project}${note}`;
}

async function fetchAll(token) {
  const res = await request('everything', { authtoken: token, since: '0' });
  if (!res.results) throw new Error(`Fetch failed: ${JSON.stringify(res)}`);
  const tasks = [];
  const projects = [];
  const tags = {};
  for (const item of res.results) {
    if (item.task) {
      for (const t of Array.isArray(item.task) ? item.task : [item.task]) {
        if (t.type === 1) projects.push(t);
        else tasks.push(t);
      }
    }
    if (item.tag) {
      for (const t of Array.isArray(item.tag) ? item.tag : [item.tag]) {
        tags[t.id] = t;
      }
    }
  }
  return { tasks, projects, tags };
}

async function saveTask(token, taskData) {
  const body = JSON.stringify([{ method: 'task.save', ...taskData }]);
  return request('', { authtoken: token }, body);
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === 'help') {
    console.log(`NirvanaHQ CLI

Commands:
  list [state]          List tasks (inbox|next|waiting|scheduled|someday|done|all)
  projects              List projects
  search <query>        Search tasks by name
  add <name> [--note N] [--state S] [--due YYYY-MM-DD] [--project ID]
                        Add a new task
  complete <id>         Mark task as done
  move <id> <state>     Move task to state (inbox|next|waiting|scheduled|someday)
  edit <id> [--name N] [--note N] [--due D]
                        Edit task fields
  delete <id>           Trash a task
  show <id>             Show task details

States: inbox, next, waiting, scheduled, someday, later, done
Task IDs: use first 8 chars of the UUID`);
    return;
  }

  const token = await auth();

  if (cmd === 'list') {
    const stateFilter = args[0] || 'next';
    const { tasks } = await fetchAll(token);
    let filtered;
    if (stateFilter === 'all') {
      filtered = tasks.filter(t => t.state < 6);
    } else {
      const stateCode = STATE_NAMES[stateFilter];
      if (stateCode === undefined) {
        console.error(`Unknown state: ${stateFilter}. Use: inbox|next|waiting|scheduled|someday|done|all`);
        process.exit(1);
      }
      filtered = tasks.filter(t => t.state === stateCode);
    }
    if (!filtered.length) {
      console.log(`No tasks in "${stateFilter}"`);
      return;
    }
    console.log(`Tasks (${stateFilter}): ${filtered.length}`);
    for (const t of filtered) console.log(formatTask(t));

  } else if (cmd === 'projects') {
    const { projects } = await fetchAll(token);
    const active = projects.filter(t => t.state === 11 || t.state === 1);
    console.log(`Active projects: ${active.length}`);
    for (const p of active) {
      const seq = p.seq === 1 ? 'sequential' : 'parallel';
      console.log(`  ${p.id.slice(0, 8)} | ${p.name} (${seq})`);
    }

  } else if (cmd === 'search') {
    const query = args.join(' ').toLowerCase();
    if (!query) { console.error('Usage: nirvana search <query>'); process.exit(1); }
    const { tasks } = await fetchAll(token);
    const found = tasks.filter(t => t.state < 6 && t.name?.toLowerCase().includes(query));
    console.log(`Found: ${found.length}`);
    for (const t of found) console.log(formatTask(t));

  } else if (cmd === 'add') {
    const name = [];
    const opts = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--note') opts.note = args[++i];
      else if (args[i] === '--state') opts.state = STATE_NAMES[args[++i]] ?? 0;
      else if (args[i] === '--due') opts.duedate = args[++i];
      else if (args[i] === '--start') opts.startdate = args[++i];
      else if (args[i] === '--project') opts.ps = args[++i];
      else name.push(args[i]);
    }
    if (!name.length) { console.error('Usage: nirvana add <name> [--note N] [--state S] [--due YYYY-MM-DD]'); process.exit(1); }
    const now = Math.floor(Date.now() / 1000).toString();
    const taskData = {
      id: crypto.randomUUID(),
      name: name.join(' '),
      type: 0,
      state: opts.state ?? 0,
      _state: now,
      _name: now,
      ...opts,
    };
    await saveTask(token, taskData);
    console.log(`Created: ${taskData.name} (${STATES[taskData.state]})`);

  } else if (cmd === 'complete') {
    const id = args[0];
    if (!id) { console.error('Usage: nirvana complete <id>'); process.exit(1); }
    const { tasks } = await fetchAll(token);
    const task = tasks.find(t => t.id.startsWith(id));
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    const now = Math.floor(Date.now() / 1000).toString();
    await saveTask(token, { id: task.id, state: 7, _state: now, completed: now });
    console.log(`Completed: ${task.name}`);

  } else if (cmd === 'move') {
    const [id, state] = args;
    if (!id || !state) { console.error('Usage: nirvana move <id> <state>'); process.exit(1); }
    const stateCode = STATE_NAMES[state];
    if (stateCode === undefined) { console.error(`Unknown state: ${state}`); process.exit(1); }
    const { tasks } = await fetchAll(token);
    const task = tasks.find(t => t.id.startsWith(id));
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    const now = Math.floor(Date.now() / 1000).toString();
    await saveTask(token, { id: task.id, state: stateCode, _state: now });
    console.log(`Moved "${task.name}" to ${state}`);

  } else if (cmd === 'edit') {
    const id = args[0];
    if (!id) { console.error('Usage: nirvana edit <id> [--name N] [--note N] [--due D]'); process.exit(1); }
    const { tasks } = await fetchAll(token);
    const task = tasks.find(t => t.id.startsWith(id));
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    const updates = { id: task.id };
    const now = Math.floor(Date.now() / 1000).toString();
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--name') { updates.name = args[++i]; updates._name = now; }
      else if (args[i] === '--note') { updates.note = args[++i]; updates._note = now; }
      else if (args[i] === '--due') { updates.duedate = args[++i]; updates._duedate = now; }
      else if (args[i] === '--start') { updates.startdate = args[++i]; updates._startdate = now; }
    }
    await saveTask(token, updates);
    console.log(`Updated: ${task.name}`);

  } else if (cmd === 'delete') {
    const id = args[0];
    if (!id) { console.error('Usage: nirvana delete <id>'); process.exit(1); }
    const { tasks } = await fetchAll(token);
    const task = tasks.find(t => t.id.startsWith(id));
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    const now = Math.floor(Date.now() / 1000).toString();
    await saveTask(token, { id: task.id, state: 6, _state: now });
    console.log(`Trashed: ${task.name}`);

  } else if (cmd === 'show') {
    const id = args[0];
    if (!id) { console.error('Usage: nirvana show <id>'); process.exit(1); }
    const { tasks, projects } = await fetchAll(token);
    const all = [...tasks, ...projects];
    const task = all.find(t => t.id.startsWith(id));
    if (!task) { console.error(`Task not found: ${id}`); process.exit(1); }
    console.log(`Name: ${task.name}`);
    console.log(`ID: ${task.id}`);
    console.log(`State: ${STATES[task.state] || task.state}`);
    console.log(`Type: ${task.type === 1 ? 'project' : 'task'}`);
    if (task.note) console.log(`Note: ${task.note}`);
    if (task.duedate) console.log(`Due: ${task.duedate}`);
    if (task.startdate) console.log(`Start: ${task.startdate}`);
    if (task.ps) console.log(`Project: ${task.ps}`);
    if (task.energy) console.log(`Energy: ${task.energy}`);
    if (task.time) console.log(`Time: ${task.time}`);

  } else {
    console.error(`Unknown command: ${cmd}. Run 'nirvana help' for usage.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
