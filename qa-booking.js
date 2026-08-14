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
 await page.waitForTimeout(1200);
 await page.locator('#bron').scrollIntoViewIfNeeded();
 await page.evaluate(()=>document.querySelector('.plan .spot:not(.busy)').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})));
 await page.waitForTimeout(500);
 const before=await page.evaluate(()=>{
  const dep=document.getElementById('bkPickDep'), ph=document.getElementById('bkPickPh');
  return {depFont:getComputedStyle(dep).fontFamily,phCursor:getComputedStyle(ph).cursor,phHidden:ph.hidden,lightboxOpen:document.getElementById('lightbox').classList.contains('open')};
 });
 await page.locator('#bkPickPh').click();
 await page.waitForTimeout(300);
 const after=await page.evaluate(()=>{
  const lb=document.getElementById('lightbox'), img=lb.querySelector('img');
  return {lightboxOpen:lb.classList.contains('open'),imgSrc:img.src,imgAlt:img.alt,cap:lb.querySelector('.lb-cap').textContent};
 });
 console.log(JSON.stringify({before,after,errors},null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
