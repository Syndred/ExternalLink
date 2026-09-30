import { initializeWorkbench } from '../src/workbench-setup.mjs';
try { console.log(JSON.stringify(await initializeWorkbench())); }
catch (error) { console.error('工作台连接未完成：' + error.message); process.exitCode = 1; }
