const { chromium } = require('/home/rodriges/6and2/landing-skill-sozdanie-sayta/node_modules/playwright');
const EXE='/home/rodriges/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE='http://127.0.0.1:8152';
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
 const results=[];
 for(const cfg of [
  {name:'desktop',width:1440,height:900,dpr:2},
  {name:'mobile',width:375,height:812,dpr:3}
 ]){
  const context=await browser.newContext({viewport:{width:cfg.width,height:cfg.height},deviceScaleFactor:cfg.dpr,reducedMotion:'no-preference'});
  const page=await context.newPage();
  const consoleErrors=[],pageErrors=[],failed=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(String(e)));
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText||''}));
  await page.goto(BASE,{waitUntil:'networkidle',timeout:30000});
  await page.locator('.g-form input').fill('6/2');
  await page.locator('.g-form button').click();
  await page.waitForTimeout(900);
  const hero=await page.evaluate(()=>{
   const line=document.querySelector('h1 .line'), dust=document.getElementById('dust');
   const cs=getComputedStyle(line), r=line.getBoundingClientRect();
   return {h1:document.querySelectorAll('h1').length,overflow:cs.overflow,paddingBottom:cs.paddingBottom,lineRect:{x:r.x,y:r.y,width:r.width,height:r.height},horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,dpr:devicePixelRatio,dustCss:[dust.clientWidth,dust.clientHeight],dustBacking:[dust.width,dust.height]};
  });
  await page.screenshot({path:`qa-feedback-${cfg.name}-hero.png`});
  await page.locator('#bron').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const initial=await page.evaluate(()=>{
   const pick=document.getElementById('bkPick'), ph=document.getElementById('bkPickPh');
   return {pickHidden:pick.hidden,pickDisplay:getComputedStyle(pick).display,phHidden:ph.hidden,phDisplay:getComputedStyle(ph).display,phSrc:ph.getAttribute('src'),dateOn:document.querySelectorAll('#bkDates .bk-chip.on').length,timeOn:document.querySelectorAll('#bkTimes .bk-chip.on').length,prompt:document.getElementById('bkV2').textContent.trim()};
  });
  await page.evaluate(()=>document.querySelector('.plan .spot:not(.busy)').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})));
  await page.waitForTimeout(900);
  const selected=await page.evaluate(()=>{
   const pick=document.getElementById('bkPick'), ph=document.getElementById('bkPickPh'), step2=document.querySelector('.bk-step[data-bk="2"]');
   return {pickHidden:pick.hidden,pickDisplay:getComputedStyle(pick).display,phHidden:ph.hidden,phDisplay:getComputedStyle(ph).display,phSrc:ph.getAttribute('src'),phComplete:ph.complete,natural:[ph.naturalWidth,ph.naturalHeight],dateOn:document.querySelectorAll('#bkDates .bk-chip.on').length,timeOn:document.querySelectorAll('#bkTimes .bk-chip.on').length,step2On:step2.classList.contains('on'),prompt:document.getElementById('bkV2').textContent.trim(),horizontalOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
  });
  await page.screenshot({path:`qa-feedback-${cfg.name}-booking.png`});
  results.push({cfg,hero,initial,selected,consoleErrors,pageErrors,failed});
  await context.close();
 }
 console.log(JSON.stringify(results,null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
