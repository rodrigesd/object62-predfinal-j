const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const EXE='/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE='http://127.0.0.1:8152';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2});
 const page=await context.newPage();
 const errors=[];
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 await page.goto(BASE,{waitUntil:'networkidle'});
 await page.locator('.g-form input').fill('6/2');
 await page.locator('.g-form button').click();
 await page.waitForTimeout(1400);
 const before=await page.evaluate(()=>{
  const pick=document.getElementById('bkPick'), ph=document.getElementById('bkPickPh'), empty=document.getElementById('bkPickEmpty');
  return {pickClass:pick.className,pickHidden:pick.hidden,emptyDisplay:getComputedStyle(empty).display,phHidden:ph.hidden,phSrc:ph.getAttribute('src'),heroLineDisplay:getComputedStyle(document.querySelector('h1 .line>span')).display,overflow:getComputedStyle(document.querySelector('h1 .line')).overflow};
 });
 await page.screenshot({path:'qa-placeholder-before.png'});
 await page.evaluate(()=>document.querySelector('.plan .spot:not(.busy)').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})));
 await page.waitForTimeout(700);
 const after=await page.evaluate(()=>{
  const pick=document.getElementById('bkPick'), ph=document.getElementById('bkPickPh'), empty=document.getElementById('bkPickEmpty');
  return {pickClass:pick.className,pickHidden:pick.hidden,emptyDisplay:getComputedStyle(empty).display,phHidden:ph.hidden,phSrc:ph.getAttribute('src'),photoOk:ph.complete&&ph.naturalWidth>0,step2On:document.querySelector('.bk-step[data-bk="2"]').classList.contains('on'),horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
 });
 await page.screenshot({path:'qa-placeholder-after.png'});
 console.log(JSON.stringify({before,after,errors},null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
