const fs=require('fs'),path=require('path');
const {build,toGcode}=require('./src/core/pipeline');
const {readSVG}=require('./src/core/svgdoc');
const DIR='C:/Users/jkevi/plotter';
for(const f of ['art-cake-outline.svg','art-calibration.svg']){
  const src=fs.readFileSync(path.join(DIR,f),'utf8');
  const t0=Date.now();
  const raw=readSVG(src,{tolerance:0.05});
  const rawN=raw.layers.reduce((a,l)=>a+l.paths.length,0);
  const r=build(src,{paperW:150,paperH:100,margin:10});
  const ms=Date.now()-t0;
  console.log(`\n== ${f}  (${(src.length/1024|0)} KB, ${ms} ms)`);
  console.log(`   doc ${raw.width?raw.width.toFixed(1):'?'} x ${raw.height?raw.height.toFixed(1):'?'} mm, layers: ${raw.layers.map(l=>l.name+':'+l.paths.length).join(', ')}`);
  console.log(`   raw paths ${rawN} -> after merge/filter ${r.stats.paths}`);
  console.log(`   fitted ${r.stats.width.toFixed(1)} x ${r.stats.height.toFixed(1)} mm  scale ${r.stats.scale.toFixed(4)}  rotated ${r.stats.rotated}  overflow ${r.stats.overflow}`);
  console.log(`   draw ${(r.stats.drawLen/1000).toFixed(2)} m   travel ${(r.stats.travelLen/1000).toFixed(2)} m   est ${r.stats.time}`);
  const g=toGcode(r.paths,r.options,{name:f,time:r.stats.time});
  const lines=g.split('\n');
  console.log(`   gcode ${lines.length} lines, ${(g.length/1024|0)} KB`);
  // bounds check: nothing may fall outside the sheet
  let mx=0,my=0; for(const p of r.paths) for(const q of p){mx=Math.max(mx,Math.abs(q[0]));my=Math.max(my,Math.abs(q[1]));}
  console.log(`   extent +/-${mx.toFixed(2)} x +/-${my.toFixed(2)} mm  (limit ${(150/2-10).toFixed(1)} x ${(100/2-10).toFixed(1)})`);
  console.log('   head:'); lines.slice(0,8).forEach(l=>console.log('     '+l));
}
