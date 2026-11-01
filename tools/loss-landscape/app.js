(() => {
const root=document.getElementById('loss-landscape');
const stateKey='loss-landscape-state-v1';
const params=new URLSearchParams(location.search),seedParam=params.get('seed');
const preview=seedParam!==null&&/^\d+$/.test(seedParam)&&Number(seedParam)<=4294967295;
if(preview)document.documentElement.classList.add('preview');
function readSavedState(){try{return JSON.parse(localStorage.getItem(stateKey));}catch{return null;}}
function storeState(state){try{localStorage.setItem(stateKey,JSON.stringify(state));}catch{}}
try {
if(!window.THREE) throw new Error('三维组件未能加载，请检查网络后重新打开。');
const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(35,1,.1,150);
const renderer=new THREE.WebGLRenderer({canvas:root.querySelector('canvas'),antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setClearColor(0,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
const target=new THREE.Vector3(0,4.6,0), stage=root.querySelector('.scene');
let yaw=.74,pitch=.48,distance=29,step=0,playing=false,frame=0,last=0,seed=preview?Number(seedParam):20261101;
const N=120;let height,extrema={peaks:0,valleys:0};
const randomFrom=s=>()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^s>>>15,1|s);t^=t+Math.imul(t^t>>>7,61|t);return((t^t>>>14)>>>0)/4294967296;};
function makeLandscape(s){
 for(let attempt=0;attempt<32;attempt++){
  const random=randomFrom((s+Math.imul(attempt,2654435761))>>>0),cells=Array.from({length:16},(_,i)=>i);
  for(let i=cells.length-1;i>0;i--){let j=Math.floor(random()*(i+1));[cells[i],cells[j]]=[cells[j],cells[i]];}
  const count=10+Math.floor(random()*4),features=cells.slice(0,count).map((cell,i)=>{const angle=random()*Math.PI;return{x:-3.6+(cell%4)*2.4+(random()-.5)*.7,z:-3.6+Math.floor(cell/4)*2.4+(random()-.5)*.7,a:(i%2?-1:1)*(.9+random()**1.5*5.1),sx:.42+random()*1.0,sz:.42+random()*1.15,c:Math.cos(angle),s:Math.sin(angle)};});
  const phase=random()*6.28,raw=(x,z)=>{let h=.018*(x*x+z*z)+.16*Math.sin(1.3*x+phase)*Math.cos(1.1*z-phase);for(const f of features){const dx=x-f.x,dz=z-f.z,u=dx*f.c+dz*f.s,v=-dx*f.s+dz*f.c;h+=f.a*Math.exp(-.5*(u*u/(f.sx*f.sx)+v*v/(f.sz*f.sz)));}return h;};
  const samples=[];let lo=Infinity,hi=-Infinity;
  for(let i=0;i<=N;i++)for(let j=0;j<=N;j++){const h=raw(i/N*10-5,j/N*10-5);samples.push(h);lo=Math.min(lo,h);hi=Math.max(hi,h);}
  let peaks=0,valleys=0;
  for(let i=1;i<N;i++)for(let j=1;j<N;j++){const index=i*(N+1)+j,h=samples[index];let peak=true,valley=true;for(let di=-1;di<=1;di++)for(let dj=-1;dj<=1;dj++){if(!di&&!dj)continue;const neighbor=samples[index+di*(N+1)+dj];peak=peak&&h>neighbor;valley=valley&&h<neighbor;}if(peak)peaks++;if(valley)valleys++;}
  if(peaks>=3&&valleys>=3||attempt===31){height=(x,z)=>.55+(raw(x,z)-lo)/(hi-lo)*8.55;extrema={peaks,valleys};return;}
 }
}
makeLandscape(seed);
const positions=[],indices=[];
for(let i=0;i<=N;i++)for(let j=0;j<=N;j++){let x=i/N*10-5,z=j/N*10-5;positions.push(x,height(x,z),z);}
for(let i=0;i<N;i++)for(let j=0;j<N;j++){let a=i*(N+1)+j,b=a+N+1;indices.push(a,a+1,b,b,a+1,b+1);}
const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();
const surfaceMaterial=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.67,metalness:.03,side:THREE.DoubleSide});
const surface=new THREE.Mesh(geometry,surfaceMaterial);scene.add(surface);
scene.add(new THREE.HemisphereLight(0xffffff,0xffffff,1.2));const light=new THREE.DirectionalLight(0xffffff,1.4);light.position.set(-3,14,8);scene.add(light);
const cage=new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(10,10,10)),new THREE.LineBasicMaterial({transparent:true,opacity:.42}));cage.position.y=5;scene.add(cage);
const grid=new THREE.GridHelper(10,10);grid.position.y=.005;grid.material.transparent=true;grid.material.opacity=.22;scene.add(grid);
const wire=new THREE.LineBasicMaterial({transparent:true,opacity:.13}),wireGroup=new THREE.Group();scene.add(wireGroup);
function rebuildWire(){for(const line of [...wireGroup.children]){wireGroup.remove(line);line.geometry.dispose();}for(let k=0;k<=20;k++)for(let direction=0;direction<2;direction++){
 const points=[];for(let j=0;j<=N;j++){let a=k/2-5,b=j/N*10-5,x=direction?a:b,z=direction?b:a;points.push(new THREE.Vector3(x,height(x,z)+.009,z));}wireGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),wire));
}}
const trajectory=[];
function rebuildTrajectory(){trajectory.length=0;const random=randomFrom(seed^0x9e3779b9);let x=2.8+random(),z=2.8+random();
for(let i=0;i<=160;i++){
 trajectory.push(new THREE.Vector3(x,height(x,z)+.065,z));
 const e=.001,gx=(height(x+e,z)-height(x-e,z))/(2*e),gz=(height(x,z+e)-height(x,z-e))/(2*e);let rate=.24,nx=x,nz=z;
 for(let backtrack=0;backtrack<20;backtrack++){nx=Math.max(-4.85,Math.min(4.85,x-rate*gx));nz=Math.max(-4.85,Math.min(4.85,z-rate*gz));if(height(nx,nz)<=height(x,z))break;rate*=.5;nx=x;nz=z;}
 if(height(nx,nz)<=height(x,z)){x=nx;z=nz;}
}}
rebuildWire();rebuildTrajectory();
const pathMaterial=new THREE.MeshBasicMaterial();
const path=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trajectory),640,.026,6,false),pathMaterial);if(!preview)scene.add(path);
const marker=new THREE.Mesh(new THREE.SphereGeometry(.125,20,14),pathMaterial);if(!preview)scene.add(marker);
const start=new THREE.Mesh(new THREE.SphereGeometry(.085,16,12),pathMaterial);start.position.copy(trajectory[0]);if(!preview)scene.add(start);
const endpoint=new THREE.Mesh(new THREE.TorusGeometry(.19,.026,8,32),pathMaterial);endpoint.rotation.x=-Math.PI/2;endpoint.position.copy(trajectory[160]);if(!preview)scene.add(endpoint);
const resolve=name=>{const span=document.createElement('span');span.style.color='var('+name+')';root.appendChild(span);const css=getComputedStyle(span).color;span.remove();if(/^(rgb|hsl|#)/.test(css))return new THREE.Color(css);const swatch=document.createElement('canvas');swatch.width=swatch.height=1;const ctx=swatch.getContext('2d');ctx.fillStyle=css;ctx.fillRect(0,0,1,1);const pixel=ctx.getImageData(0,0,1,1).data;return new THREE.Color().setRGB(pixel[0]/255,pixel[1]/255,pixel[2]/255,THREE.SRGBColorSpace);};
function theme(){
 const stops=Array.from({length:7},(_,i)=>resolve('--terrain-'+i)),colors=[];
 for(let i=1;i<positions.length;i+=3){let t=Math.max(0,Math.min(1,(positions[i]-.55)/8.55))*(stops.length-1),k=Math.min(stops.length-2,Math.floor(t)),color=stops[k].clone().lerp(stops[k+1],t-k);colors.push(color.r,color.g,color.b);}
 geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));const neutral=resolve('--foreground');cage.material.color.copy(neutral);wire.color.copy(neutral);grid.material.color.copy(neutral);pathMaterial.color.copy(neutral);draw();
}
const slider=root.querySelector('#loss-step'),value=root.querySelector('#loss-step-value'),lossValue=root.querySelector('#loss-value'),play=root.querySelector('#loss-play');
const seedInput=root.querySelector('#loss-seed'),featureLabel=root.querySelector('#loss-features');
function describe(){seedInput.value=seed;featureLabel.textContent=extrema.peaks+' 个山峰 · '+extrema.valleys+' 个低谷';}
function regenerate(nextSeed){
 playing=false;cancelAnimationFrame(frame);play.textContent='播放下降';step=0;seed=nextSeed>>>0;makeLandscape(seed);
 for(let i=0;i<positions.length;i+=3)positions[i+1]=height(positions[i],positions[i+2]);
 geometry.attributes.position.array.set(positions);geometry.attributes.position.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingSphere();
 rebuildWire();rebuildTrajectory();path.geometry.dispose();path.geometry=new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trajectory),640,.026,6,false);start.position.copy(trajectory[0]);endpoint.position.copy(trajectory[160]);describe();theme();update();
}
seedInput.addEventListener('change',()=>{const n=Number(seedInput.value),error=root.querySelector('#loss-error');if(seedInput.value.trim()===''||!Number.isInteger(n)||n<0||n>4294967295){error.hidden=false;error.textContent='请输入 0 到 4294967295 之间的整数种子。';return;}error.hidden=true;regenerate(n);save();});
root.querySelector('#loss-random').addEventListener('click',()=>{let next=Math.floor(Math.random()*4294967296);if(next===seed)next=(seed+1)>>>0;root.querySelector('#loss-error').hidden=true;regenerate(next);save();});
const previewLink=root.querySelector('#loss-preview-link'),previewOutput=root.querySelector('#loss-preview-output'),copyStatus=root.querySelector('#loss-copy-status');
root.querySelector('#loss-preview').addEventListener('click',()=>{
 const url=new URL(location.href);url.search='';url.hash='';
 url.searchParams.set('seed',seed);
 for(const [name,value] of Object.entries({yaw,pitch,distance}))url.searchParams.set(name,value.toFixed(6));
 previewLink.value=url.href;root.querySelector('#loss-preview-open').href=url.href;
 previewOutput.hidden=false;copyStatus.textContent='';previewLink.focus();previewLink.select();
});
root.querySelector('#loss-preview-copy').addEventListener('click',async()=>{
 try{await navigator.clipboard.writeText(previewLink.value);copyStatus.textContent='链接已复制';}
 catch{previewLink.focus();previewLink.select();copyStatus.textContent='请复制已选中的链接';}
});
function update(){marker.position.copy(trajectory[step]);value.value=step;slider.value=step;lossValue.textContent='Loss '+(trajectory[step].y-.065).toFixed(3);draw();}
function draw(){
 const fitDistance=distance*Math.max(1,1/camera.aspect);camera.position.set(target.x+fitDistance*Math.cos(pitch)*Math.sin(yaw),target.y+fitDistance*Math.sin(pitch),target.z+fitDistance*Math.cos(pitch)*Math.cos(yaw));camera.lookAt(target);camera.updateMatrixWorld();renderer.render(scene,camera);
 for(const label of root.querySelectorAll('[data-point]')){const p=new THREE.Vector3(...label.dataset.point.split(',').map(Number)).project(camera);label.style.left=Math.max(32,Math.min(stage.clientWidth-34,(p.x+1)*stage.clientWidth/2))+'px';label.style.top=Math.max(14,Math.min(stage.clientHeight-14,(-p.y+1)*stage.clientHeight/2))+'px';}
}
function resize(){renderer.setSize(stage.clientWidth,stage.clientHeight,false);camera.aspect=stage.clientWidth/stage.clientHeight;camera.updateProjectionMatrix();draw();}
function save(){if(preview)return;root.querySelector('#loss-announcement').textContent='种子 '+seed+'，训练步数 '+step+'，'+lossValue.textContent;storeState({modelContent:{seed,peaks:extrema.peaks,valleys:extrema.valleys,step,loss:+(trajectory[step].y-.065).toFixed(3)},privateContent:{yaw,pitch,distance}});}
function restore(state){if(!state)return;const a=state.privateContent||{},b=state.modelContent||{};if(Number.isInteger(b.seed)&&b.seed>=0&&b.seed<=4294967295&&b.seed!==seed)regenerate(b.seed);if(Number.isFinite(a.yaw))yaw=a.yaw;if(Number.isFinite(a.pitch))pitch=Math.max(.12,Math.min(1.35,a.pitch));if(Number.isFinite(a.distance))distance=Math.max(23,Math.min(40,a.distance));if(Number.isFinite(b.step))step=Math.max(0,Math.min(160,Math.round(b.step)));update();}
slider.addEventListener('input',()=>{playing=false;cancelAnimationFrame(frame);play.textContent='播放下降';step=+slider.value;update();});slider.addEventListener('change',save);
function animate(now){if(!playing)return;if(now-last>45){last=now;step=Math.min(160,step+1);update();}if(step<160)frame=requestAnimationFrame(animate);else{playing=false;play.textContent='重新播放';save();}}
play.addEventListener('click',()=>{if(playing){playing=false;cancelAnimationFrame(frame);play.textContent='继续下降';save();return;}if(step===160)step=0;playing=true;play.textContent='暂停';last=0;if(matchMedia('(prefers-reduced-motion: reduce)').matches){step=160;update();playing=false;play.textContent='重新播放';save();}else frame=requestAnimationFrame(animate);});
let drag=null;const canvas=renderer.domElement;
canvas.addEventListener('pointerdown',e=>{drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);canvas.style.cursor='grabbing';});
canvas.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;yaw-=(e.clientX-drag.x)*.008;pitch=Math.max(.12,Math.min(1.35,pitch+(e.clientY-drag.y)*.006));drag.x=e.clientX;drag.y=e.clientY;draw();});
canvas.addEventListener('pointerup',()=>{drag=null;canvas.style.cursor='grab';save();});canvas.addEventListener('pointercancel',()=>{drag=null;canvas.style.cursor='grab';});
canvas.addEventListener('wheel',e=>{e.preventDefault();distance=Math.max(23,Math.min(40,distance+e.deltaY*.012));draw();save();},{passive:false});
const colorScheme=matchMedia('(prefers-color-scheme: dark)');
colorScheme.addEventListener?.('change',theme);
new ResizeObserver(resize).observe(stage);new MutationObserver(theme).observe(document.documentElement,{attributes:true,attributeFilter:['class','style','data-theme']});
if(preview){
 for(const child of scene.children)child.visible=child===surface||child.isLight;
 const cameraValue=(name,fallback,min=-Infinity,max=Infinity)=>{const raw=params.get(name),n=Number(raw);return raw!==null&&raw.trim()!==''&&Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;};
 yaw=cameraValue('yaw',yaw);pitch=cameraValue('pitch',pitch,.12,1.35);distance=cameraValue('distance',distance,23,40);
 document.title='Loss Landscape · 种子 '+seed;
}
describe();theme();resize();if(!preview)restore(readSavedState());update();
} catch(error){const box=root.querySelector('#loss-error');box.hidden=false;box.textContent=error.message;}
})();
