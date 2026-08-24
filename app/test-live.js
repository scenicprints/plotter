const {Machine}=require('./src/main/machine');
(async()=>{
  const m=new Machine('plotter.local');
  const info=await m.mr.info();
  console.log('klipper:', info.state, '|', info.software_version, '|', info.hostname);
  const s=await m.refresh();
  console.log('\nparsed status');
  for(const k of ['klipper','homedAxes','homedXY','homedZ','x','y','z','originX','originY',
                  'zeroed','lift','maxFloat','paperW','paperH','zUpFeed','zDownFeed','travelFeed',
                  'printState','printing','progress'])
    console.log('  '+k.padEnd(12), JSON.stringify(s[k]));
  console.log('  axisMax    ', JSON.stringify(s.axisMax));
  const pre=await m.preflight();
  console.log('\npreflight ok:',pre.ok);
  pre.problems.forEach(p=>console.log('  - '+p));
  const log=await m.console(6);
  console.log('\nlast console lines:');
  log.slice(-6).forEach(l=>console.log('  '+(l.type==='command'?'> ':'')+String(l.message).split('\n')[0].slice(0,110)));
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1)});
