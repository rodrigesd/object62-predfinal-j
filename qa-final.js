const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const EXE='/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE='http://127.0.0.1:8152';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
 for(const cfg of [{name:'desktop',width:1440,height:900,dpr:1},{name:'retina',width:1440,height:900,dpr:2}]){
  const context=await browser.newContext({viewport:{width:cfg.width,height:cfg.height},deviceScaleFactor:cfg.dpr});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto(BASE,{waitUntil:'networkidle'});
  await page.locator('.g-form input').fill('6/2');
  await page.locator('.g-form button').click();
  await page.waitForTimeout(1800);
  const data=await page.evaluate(()=>{
   const line=document.querySelector('h1 .line'), span=document.querySelector('h1 .line>span'), dust=document.getElementById('dust');
   const cs=getComputedStyle(span);
   return {h1:document.querySelectorAll('h1').length,lineOverflow:getComputedStyle(line).overflow,spanDisplay:cs.display,spanPaddingBottom:cs.paddingBottom,spanMarginBottom:cs.marginBottom,horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,dpr:devicePixelRatio,dustCss:[dust.clientWidth,dust.clientHeight],dustBacking:[dust.width,dust.height]};
  });
  await page.screenshot({path:`qa-final-${cfg.name}.png`});
  console.log(JSON.stringify({cfg,data,errors},null,2));
  await context.close();
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
