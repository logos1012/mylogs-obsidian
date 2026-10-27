import { vaultIO, exclusive } from "../pinboard/create-actions.ts";
import { commitBatch, type Write } from "../pinboard/batch.ts";
import { parseWallYear } from "../wall/parse.ts";
import { deskLineFor, insertIntoDesk, markSentToDesk } from "../wall/edit.ts";
import { refreshCalendarIndex } from "../projects/calendar-index.ts";
import { setFrontmatterScalar } from "../writer.ts";
import { type App, normalizePath, Notice, TFile } from "obsidian";
import type { MyLogsSettings } from "../settings.ts";
import { newMonthSkeleton, parseMonthKey, todayIsoLocal } from "./model.ts";
import { prependChangeLog } from "./ops.ts";

export const DESK_INDEX_FILE = "Desk Calendar Index.md";

export interface DeskHost {
	app: App;
	settings: MyLogsSettings;
}

export function deskMonthPath(host: DeskHost, key: string): string {
	return normalizePath(`${host.settings.deskCalendarFolder}/${key.slice(0, 4)}/${key}.md`);
}

/** Prepend `- YYYY-MM-DD: what (플러그인)` to `## 변경 기록` of `Desk Calendar Index.md` and set `updated`. */
export async function logDeskChange(host: DeskHost, what: string): Promise<void> {
	const path = normalizePath(`${host.settings.deskCalendarFolder}/${DESK_INDEX_FILE}`);
	const f = host.app.vault.getAbstractFileByPath(path);
	if (!(f instanceof TFile)) {
		console.warn(`[MyLogs] ${path} not found; change log not written`);
		return;
	}
	const today = todayIsoLocal();
	await host.app.vault.process(f, (data) => prependChangeLog(data, today, what));
}

/**
 * Create a month file with exactly the skeleton of `_build/new_month.py`. Refuses when the file
 * already exists. Returns true when it was created.
 */
export async function createDeskMonth(host: DeskHost, key: string): Promise<boolean> {
 const ym=parseMonthKey(key);
 if(!ym || !/^\d{4}-\d{2}$/.test(key) || ym.year<1900 || ym.year>2999){new Notice("달은 YYYY-MM 형식이어야 해요.");return false;}
 try { return await exclusive(host,async()=>{
  const io=vaultIO(host.app),path=deskMonthPath(host,key),today=todayIsoLocal();
  if(await io.read(path)!==null){new Notice(`이미 있는 파일이에요. 덮어쓰지 않았어요.\n${path}`);return false;}
  const wallPath=normalizePath(`${host.settings.wallCalendarFolder}/${ym.year}.md`),wall=await io.read(wallPath);
  let desk=newMonthSkeleton(ym.year,ym.month,today),changedWall=wall;const titles:string[]=[];
  if(wall!==null){
   const pending=parseWallYear(wall,ym.year).months[ym.month-1].lines.filter(l=>l.item.status==="scheduled");
   if(pending.length&&key<today.slice(0,7))throw Error("지난달 Wall Calendar 기록은 읽기 전용이에요. 새 달을 만들며 옮기지 않았어요.");
   for(const line of pending){
    if(!line.item.ok||line.item.problems.length)throw Error(`Wall Calendar 항목 형식을 확인해 주세요: ${line.item.text}`);
    const date=line.item.start;
    if(date&&!date.startsWith(key+"-"))throw Error(`Wall Calendar 날짜가 달과 달라요: ${line.item.text}`);
    const result=insertIntoDesk(desk,deskLineFor(line.line.replace(/^\s*[-*+]\s+/,""),line.item),date);
    const sent=markSentToDesk(changedWall!,ym.year,line, path.replace(/\.md$/,""));
    if(!result.ok||!sent.ok)throw Error("Wall → Desk 변환 중 원본 형식을 확인해야 해요.");
    desk=result.text;changedWall=sent.text;titles.push(line.item.text);
   }
  }
  const writes:Write[]=[{path,before:null,after:desk}];
  if(changedWall!==wall)writes.push({path:wallPath,before:wall,after:setFrontmatterScalar(changedWall!,"updated",today)});
  const files=new Map<string,string>();for(const f of host.app.vault.getMarkdownFiles())if(f.path.startsWith(host.settings.deskCalendarFolder+"/")||f.path.startsWith(host.settings.wallCalendarFolder+"/"))files.set(f.path,await host.app.vault.read(f));
  for(const w of writes)files.set(w.path,w.after);
  for(const [kind,root,name] of [["desk",host.settings.deskCalendarFolder,"Desk Calendar Index.md"],...(titles.length?[["wall",host.settings.wallCalendarFolder,"Wall Calendar Index.md"]]:[])]){
   const ip=normalizePath(`${root}/${name}`),before=await io.read(ip);if(before===null)throw Error(`등록부가 없어요: ${ip}`);
   const after=prependChangeLog(refreshCalendarIndex(before,kind as "desk"|"wall",files,root,today),today,`${key} 새 달 만들기 · Wall 예정 ${titles.length}개 이전${titles.length?": "+titles.join(", "):""}`);writes.push({path:ip,before,after});
  }
  await commitBatch(io,writes);new Notice(`${key} Desk Calendar를 만들었어요.${titles.length?`\nWall에서 ${titles.length}개 이전: ${titles.join(", ")}`:""}`);return true;
 }); }catch(e){new Notice(e instanceof Error?e.message:String(e));return false;}
}
