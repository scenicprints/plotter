const {readSVG}=require('./src/core/svgdoc');
const G=require('./src/core/geom');
let fail=0;
const ok=(name,cond,got,want)=>{if(cond)console.log('  ok   '+name);else{fail++;console.log('  FAIL '+name+'  got '+got+' want '+want);}};
const near=(a,b,t)=>Math.abs(a-b)<=t;
// mm-exact doc: 100x100 user units == 100x100 mm
const doc=(body,extra='')=>`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100" ${extra}>${body}</svg>`;
const P=(body,extra)=>readSVG(doc(body,extra),{tolerance:0.01}).layers.flatMap(l=>l.paths);

console.log('\nprimitives');
let p=P('<circle cx="50" cy="50" r="10"/>')[0];
ok('circle perimeter 62.83', near(G.pathLength(p),2*Math.PI*10,0.05), G.pathLength(p).toFixed(3), 62.832);
ok('circle closed', G.isClosed(p,1e-6), '', '');
p=P('<rect x="10" y="20" width="30" height="40"/>')[0];
ok('rect perimeter 140', near(G.pathLength(p),140,1e-6), G.pathLength(p), 140);
let bb=G.bbox(P('<rect x="10" y="20" width="30" height="40" rx="5"/>'));
ok('rounded rect bbox', near(bb.w,30,.01)&&near(bb.h,40,.01), `${bb.w.toFixed(2)}x${bb.h.toFixed(2)}`, '30x40');
p=P('<polygon points="0,0 10,0 10,10"/>')[0];
ok('polygon auto-closes', G.isClosed(p,1e-9)&&near(G.pathLength(p),10+10+Math.hypot(10,10),1e-9), G.pathLength(p).toFixed(4), 34.1421);
p=P('<ellipse cx="50" cy="50" rx="20" ry="10"/>')[0];
ok('ellipse bbox 40x20', (b=>near(b.w,40,.02)&&near(b.h,20,.02))(G.bbox([p])), '', '');

console.log('\npath commands');
p=P('<path d="M10 10 L20 10 L20 20 Z"/>')[0];
ok('Z closes back to start', near(p[p.length-1][0],10,1e-9)&&near(p[p.length-1][1],10,1e-9),'','');
p=P('<path d="m10 10 l10 0 l0 10 z"/>')[0];
ok('relative == absolute', near(G.pathLength(p),10+10+Math.hypot(10,10),1e-9),'','');
p=P('<path d="M0 0 10 0 10 10"/>')[0];
ok('implicit L after M', p.length===3&&near(G.pathLength(p),20,1e-9), p.length, 3);
p=P('<path d="M0 0 H50 V50 H0 Z"/>')[0];
ok('H/V', near(G.pathLength(p),200,1e-9), G.pathLength(p), 200);
// quarter arc r=25 -> length pi*25/2 = 39.27
p=P('<path d="M0 25 A25 25 0 0 1 25 0"/>')[0];
ok('arc quarter length', near(G.pathLength(p),Math.PI*25/2,0.02), G.pathLength(p).toFixed(3), 39.270);
ok('arc endpoint', near(p[p.length-1][0],25,1e-6)&&near(p[p.length-1][1],0,1e-6), p[p.length-1].map(v=>v.toFixed(3)).join(','), '25,0');
// large-arc / sweep flags: 3/4 circle
p=P('<path d="M0 25 A25 25 0 1 0 25 0"/>')[0];
ok('arc large+sweep0 length', near(G.pathLength(p),2*Math.PI*25*0.75,0.05), G.pathLength(p).toFixed(2), (2*Math.PI*25*.75).toFixed(2));
// S must mirror the previous C control point -> symmetric S curve ends at 40,0
p=P('<path d="M0 0 C10 -10 20 -10 30 0 S50 10 60 0"/>')[0];
ok('S continuation ends at 60,0', near(p[p.length-1][0],60,1e-6)&&near(p[p.length-1][1],0,1e-6), p[p.length-1].map(v=>v.toFixed(2)).join(','), '60,0');
p=P('<path d="M0 0 Q10 -10 20 0 T40 0"/>')[0];
ok('T continuation ends at 40,0', near(p[p.length-1][0],40,1e-6), p[p.length-1][0].toFixed(3), 40);
// flattening accuracy: half-circle drawn as two cubics vs true length
p=P('<path d="M0 0 C0 -13.807 11.193 -25 25 -25 C38.807 -25 50 -13.807 50 0"/>')[0];
ok('cubic half-circle ~ pi*25', near(G.pathLength(p),Math.PI*25,0.06), G.pathLength(p).toFixed(3), (Math.PI*25).toFixed(3));

console.log('\ntransforms');
bb=G.bbox(P('<rect x="0" y="0" width="10" height="10" transform="translate(20,30)"/>'));
ok('translate', near(bb.x0,20,1e-9)&&near(bb.y0,30,1e-9), `${bb.x0},${bb.y0}`, '20,30');
bb=G.bbox(P('<rect x="0" y="0" width="10" height="10" transform="scale(2,3)"/>'));
ok('scale', near(bb.w,20,1e-9)&&near(bb.h,30,1e-9), `${bb.w}x${bb.h}`, '20x30');
bb=G.bbox(P('<rect x="0" y="0" width="10" height="10" transform="rotate(90)"/>'));
ok('rotate 90', near(bb.x0,-10,1e-9)&&near(bb.y0,0,1e-9), `${bb.x0.toFixed(3)},${bb.y0.toFixed(3)}`, '-10,0');
bb=G.bbox(P('<rect x="0" y="0" width="10" height="10" transform="rotate(90,5,5)"/>'));
ok('rotate about point', near(bb.x0,0,1e-9)&&near(bb.y0,0,1e-9), `${bb.x0.toFixed(3)},${bb.y0.toFixed(3)}`, '0,0');
bb=G.bbox(P('<g transform="translate(10,10)"><g transform="scale(2)"><rect x="0" y="0" width="5" height="5"/></g></g>'));
ok('nested g compose', near(bb.x0,10,1e-9)&&near(bb.w,10,1e-9), `${bb.x0},${bb.w}`, '10,10');
bb=G.bbox(P('<rect x="0" y="0" width="10" height="10" transform="matrix(1 0 0 1 7 8)"/>'));
ok('matrix', near(bb.x0,7,1e-9)&&near(bb.y0,8,1e-9), `${bb.x0},${bb.y0}`, '7,8');

console.log('\nunits + viewBox');
let d=readSVG('<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 400 200"><line x1="0" y1="0" x2="400" y2="0"/></svg>',{});
ok('viewBox scales to mm', near(G.pathLength(d.layers[0].paths[0]),200,1e-6), G.pathLength(d.layers[0].paths[0]).toFixed(4), 200);
d=readSVG('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><line x1="0" y1="0" x2="96" y2="0"/></svg>',{});
ok('bare px -> 25.4mm', near(G.pathLength(d.layers[0].paths[0]),25.4,1e-6), G.pathLength(d.layers[0].paths[0]).toFixed(4), 25.4);

console.log('\nvisibility + layers');
ok('display:none skipped', P('<rect x="0" y="0" width="10" height="10" display="none"/>').length===0,'','');
ok('style display none skipped', P('<rect x="0" y="0" width="10" height="10" style="fill:none;display:none"/>').length===0,'','');
ok('stroke:none still imported', P('<rect x="0" y="0" width="10" height="10" style="stroke:none;fill:#000"/>').length===1,'','');
d=readSVG(doc('<g inkscape:groupmode="layer" inkscape:label="art"><rect x="0" y="0" width="9" height="9"/></g><g inkscape:groupmode="layer" inkscape:label="text"><rect x="0" y="0" width="9" height="9"/></g>'),{});
ok('two named layers in order', d.layers.length===2&&d.layers[0].name==='art'&&d.layers[1].name==='text', d.layers.map(l=>l.name).join(','), 'art,text');

console.log('\ngeometry ops');
const sq=[[0,0],[5,0],[10,0],[10,10],[10,20]];
ok('simplify drops collinear', G.simplify(sq,0.01).length===3, G.simplify(sq,0.01).length, 3);
const m=G.merge([[[0,0],[10,0]],[[10,0],[10,10]],[[50,50],[60,50]]],0.1);
ok('merge joins 2 of 3', m.length===2, m.length, 2);
const mr=G.merge([[[0,0],[10,0]],[[10,10],[10,0]]],0.1);
ok('merge reverses to join', mr.length===1&&mr[0].length===3, mr.length, 1);
ok('filterMin', G.filterMin([[[0,0],[0,0.2]],[[0,0],[0,5]]],0.5).length===1,'','');
const s=G.sortPaths([[[100,100],[110,100]],[[1,1],[2,1]]],0,0);
ok('sort picks nearest first', s.paths[0][0][0]===1, s.paths[0][0][0], 1);
const rl=G.reloop([[0,0],[10,0],[10,10],[0,10],[0,0]],10,10);
ok('reloop seams near pen', rl[0][0]===10&&rl[0][1]===10, rl[0].join(','), '10,10');
ok('reloop stays closed', G.isClosed(rl,1e-9),'','');

console.log(fail?`\n${fail} FAILED`:'\nall passed');
process.exit(fail?1:0);
