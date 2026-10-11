import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sources=[
  "services/commands.js",
  "services/state.js",
  "components/elements.js",
  "components/forms.js",
  "services/api.js",
  "services/actions.js",
  "pages/project-forms.js",
  "pages/projects.js",
  "components/ad-copy.js",
  "pages/product.js",
  "pages/triage.js",
  "pages/reports.js",
  "pages/settings.js",
  "pages/exploration.js",
  "services/log-session.js",
  "components/live-logs.js",
  "components/events.js",
  "services/marketing_bridge.js"
];
await mkdir('dist',{recursive:true});
const scripts=await Promise.all([...sources,'pages/focused-exploration.js','bootstrap.js'].map(async p=>'\n// Source: '+p+'\n'+await readFile(p,'utf8')));
await writeFile('dist/workbench.js',scripts.join('\n'));
const css=await Promise.all(['styles/workbench.css','styles/workbench-guided.css','styles/workbench-focus.css','dist/tailwind.css'].map(p=>readFile(p,'utf8')));
await writeFile('dist/app.css',css.join('\n'));
await cp('workbench.html','dist/workbench.html');
await cp('legacy/dashboard.html','dist/dashboard.html');
await cp('ui-icons','dist/ui-icons',{recursive:true});
const hash=createHash('sha256').update(scripts.join('\n')).update(css.join('\n')).digest('hex');
await writeFile('dist/build.json',JSON.stringify({hash,sources:[...sources,'pages/focused-exploration.js','bootstrap.js']},null,2)+'\n');
console.log('Built workbench:',hash);
