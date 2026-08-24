// Writes build/icon.png (512x512 RGBA) with no image dependency.
const zlib=require('zlib'),fs=require('fs');
const S=512, px=Buffer.alloc(S*S*4);
const T=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c>>>0;}
const crc=b=>{let c=0xFFFFFFFF;for(const x of b)c=T[(c^x)&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;};
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);
  const td=Buffer.concat([Buffer.from(type,'ascii'),data]);const cr=Buffer.alloc(4);cr.writeUInt32BE(crc(td));
  return Buffer.concat([len,td,cr]);};
const set=(x,y,r,g,b,a)=>{if(x<0||y<0||x>=S||y>=S)return;const i=(y*S+x)*4;
  const A=a/255, ia=1-A, o=px[i+3]/255;
  px[i]=Math.round(r*A+px[i]*ia); px[i+1]=Math.round(g*A+px[i+1]*ia);
  px[i+2]=Math.round(b*A+px[i+2]*ia); px[i+3]=Math.round(255*(A+o*ia));};
// rounded square background, warm dark
const R=112, pad=16;
for(let y=0;y<S;y++)for(let x=0;x<S;x++){
  const cx=Math.min(Math.max(x,pad+R),S-pad-R), cy=Math.min(Math.max(y,pad+R),S-pad-R);
  const d=Math.hypot(x-cx,y-cy);
  const a=Math.max(0,Math.min(1,(R-d+.5)));
  if(a>0){const t=y/S; set(x,y, Math.round(0x2E-6*t), Math.round(0x29-4*t), Math.round(0x22-2*t), Math.round(a*255));}
}
// pen nib: teal outline triangle with a dot, matching the app mark
const cxm=S/2, top=132, bot=402, half=104;
const inside=(x,y,shrink)=>{
  const t=(y-top)/(bot-top); if(t<0||t>1)return false;
  const w=half*(1-t*0.62)-shrink;
  return Math.abs(x-cxm)<=w;
};
for(let y=0;y<S;y++)for(let x=0;x<S;x++){
  if(inside(x,y,0)&&!inside(x,y,17)) set(x,y,0x74,0xB6,0xC0,255);
}
// nib slit + ink dot
for(let y=246;y<bot-14;y++)for(let x=cxm-7;x<=cxm+7;x++) if(inside(x,y,17)) set(x,y,0x74,0xB6,0xC0,255);
for(let y=0;y<S;y++)for(let x=0;x<S;x++){
  const d=Math.hypot(x-cxm,y-236);
  if(d<38) set(x,y,0xE0,0xA1,0x5A,Math.round(255*Math.max(0,Math.min(1,38-d))));
}
const raw=Buffer.alloc(S*(S*4+1));
for(let y=0;y<S;y++){raw[y*(S*4+1)]=0;px.copy(raw,y*(S*4+1)+1,y*S*4,(y+1)*S*4);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(S,0);ihdr.writeUInt32BE(S,4);
ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
fs.mkdirSync('build',{recursive:true});
fs.writeFileSync('build/icon.png',Buffer.concat([
  Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]),
  chunk('IHDR',ihdr), chunk('IDAT',zlib.deflateSync(raw,{level:9})), chunk('IEND',Buffer.alloc(0)),
]));
console.log('build/icon.png', fs.statSync('build/icon.png').size, 'bytes');
