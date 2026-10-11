const { _electron:electron,expect }=require('@playwright/test');
const fs=require('fs'),path=require('path'),http=require('http');
const {execFileSync}=require('child_process');
const lock=require('../upstream-lock.json');
const root=path.resolve(__dirname,'..'),appPath=process.env.BRUNO_TEST_APP;
if(!appPath) throw new Error('BRUNO_TEST_APP must name an isolated test installation');
const baseline=process.argv.includes('--english'), L=(zh,en)=>baseline?en:zh;
const run=path.join(root,'work','smoke-'+(baseline?'en':'zh')+'-'+Date.now());
const profile=path.join(run,'profile'),storage=path.join(run,'collections');
fs.mkdirSync(profile,{recursive:true});fs.mkdirSync(storage,{recursive:true});
fs.writeFileSync(path.join(profile,'preferences.json'),JSON.stringify({preferences:{
  general:{defaultLocation:storage},autoupdate:{downloadUpdates:false},telemetry:{enabled:false},
  onboarding:{hasLaunchedBefore:true,hasSeenWelcomeModal:false,lastSeenVersion:lock.version,hasSentFirstRequest:false}
}}));
const artifacts=path.join(root,'artifacts');fs.mkdirSync(artifacts,{recursive:true});
const payload={Name:'Name',Value:'Save',Description:'Send',message:'Create Collection',ok:true};
const received=[];
const server=http.createServer((request,response)=>{let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
  received.push({method:request.method,url:request.url,body});
  response.setHeader('Content-Type','application/json');response.end(JSON.stringify(payload));
});});
let app,stage='launch';
const deadline=setTimeout(()=>{console.error('Native smoke timed out at stage: '+stage);app?.process().kill('SIGKILL');server.closeAllConnections();process.exit(1);},120000);
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  app=await electron.launch({executablePath:path.join(appPath,process.platform==='darwin'?'Contents/MacOS/Bruno':'Bruno.exe'),
    args:['--user-data-dir='+profile],env:{...process.env,PLAYWRIGHT:'true',DISABLE_SINGLE_INSTANCE:'true'},timeout:60000});
  const append=(kind,text)=>fs.appendFileSync(path.join(artifacts,process.platform+'-'+(baseline?'en':'zh')+'-runtime.log'),kind+': '+String(text)+'\n');
  app.process().stderr.on('data',data=>append('stderr',data));
  app.on('console',message=>append('main',message.text()));
  const page=await app.firstWindow();const errors=[];
  page.on('console',message=>append('renderer',message.text()));
  page.on('crash',()=>append('crash','Renderer crashed'));
  page.on('pageerror',error=>errors.push({message:error.message,stage}));
  await page.waitForLoadState('domcontentloaded');
  expect(await app.evaluate(({app})=>app.getPath('userData'))).toBe(profile);
  expect(await app.evaluate(({app})=>app.getVersion())).toBe(lock.version);
  await page.getByRole('button',{name:L('我先自己看看',"I'll explore on my own"),exact:true}).click();
  stage='preferences';
  await page.getByRole('button',{name:L('打开偏好设置','Open Preferences'),exact:true}).click();
  await expect(page.getByText(L('SSL/TLS 证书验证','SSL/TLS Certificate Verification'),{exact:true})).toBeVisible();
  stage='request';
  await page.getByRole('button',{name:L('新建临时请求','New Transient Request'),exact:true}).click();
  await page.locator('.CodeMirror').first().waitFor();
  const url='http://127.0.0.1:'+server.address().port+'/echo?name=Save';
  await page.locator('.CodeMirror').first().evaluate((element,value)=>element.CodeMirror.setValue(value),url);
  await page.getByRole('button',{name:L('发送','Send'),exact:true}).click();
  await expect.poll(()=>received.length).toBe(1);
  expect(received[0]).toEqual({method:'GET',url:'/echo?name=Save',body:''});
  await expect(page.getByText('200 OK',{exact:true})).toBeVisible();
  await expect.poll(()=>page.locator('.CodeMirror').evaluateAll(es=>es.map(e=>e.CodeMirror?.getValue()))).toContain(JSON.stringify(payload,null,2));
  if(!baseline){
    expect(await page.locator('body').innerText()).toContain('名称');
    await page.screenshot({path:path.join(artifacts,process.platform+'-request.png')});
  }
  stage='save-dialog';await page.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
  const modal=page.getByTestId('save-transient-request-modal');await modal.waitFor();
  await page.getByTestId('save-transient-request-name').fill('Create Collection');
  await modal.getByText(L('新建集合','New collection'),{exact:true}).click();
  await page.getByPlaceholder(L('输入集合名称','Enter collection name')).fill('local-smoke');
  stage='create-collection';await page.getByRole('button',{name:L('创建','Create'),exact:true}).click();
  await modal.getByText('local-smoke',{exact:true}).click();
  stage='save-request';await page.getByTestId('save-transient-request-submit').click();
  const saved=path.join(storage,'local-smoke','Create Collection.yml');
  await expect.poll(()=>fs.existsSync(saved)?fs.readFileSync(saved,'utf8'):'').toContain('name: Create Collection');
  const content=fs.readFileSync(saved,'utf8');expect(content).toContain('name: Create Collection');expect(content).toContain('value: Save');expect(content).toContain('method: GET');
  const menu=await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.map(i=>i.label));
  expect(menu).toContain(L('集合','Collection'));expect(menu).toContain(L('编辑','Edit'));
  fs.writeFileSync(path.join(artifacts,process.platform+'-'+(baseline?'en':'zh')+'.json'),JSON.stringify({version:lock.version,platform:process.platform,arch:process.arch,passed:true,errors,checks:['startup','preferences','HTTP 200','unaltered URL and JSON','create collection','save unchanged English request name','native menus']},null,2));
  console.log('PASS '+process.platform+' '+(baseline?'original':'Chinese')+' '+lock.version);
}
main().catch(async e=>{console.error('Failure at stage: '+stage,e);process.exitCode=1;
  if(process.platform==='darwin'&&process.env.CI){
    try{execFileSync('/usr/sbin/screencapture',['-x',path.join(artifacts,'darwin-desktop-failure.png')],{timeout:10000});}catch{}
    if(app)try{execFileSync('/usr/bin/sample',[String(app.process().pid),'3','-file',path.join(artifacts,'darwin-sample.txt')],{timeout:10000});}catch{}
  }
  if(app){try{await app.firstWindow().then(page=>page.screenshot({path:path.join(artifacts,process.platform+'-failure.png'),timeout:5000}));}catch{}}
}).finally(async()=>{
  server.closeAllConnections();server.close();if(app){try{await Promise.race([app.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('close timeout')),5000))]);}catch{app.process().kill('SIGKILL');}}
  clearTimeout(deadline);
});
