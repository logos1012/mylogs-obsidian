/** Update machine-readable registry tables, retaining prose and each row's user notes. */
import { parseMonthFile, dayIndex, summarizeMonth, weekAllocStats, mmdd } from "../desk/model.ts";
import { parseWallYear, countStatuses } from "../wall/parse.ts";
import { addDays } from "../parser.ts";
const cell=(s:unknown)=>String(s??"").replace(/\|/g,"\\|").replace(/[\r\n]+/g," ");
function table(text:string,title:string,headers:string[],rows:string[][],keepNotes=false):string {
 const eol=text.includes("\r\n")?"\r\n":"\n",lines=text.split(/\r?\n/),at=lines.findIndex(l=>/^#{2,3} /.test(l)&&l.replace(/^#+\s*/,"").startsWith(title));
 if(at<0)return text+eol+`## ${title}`+eol+eol+[headers,headers.map(()=>"---"),...rows].map(r=>"| "+r.map(cell).join(" | ")+" |").join(eol)+eol;
 let end=at+1;while(end<lines.length&&!/^#{1,3} /.test(lines[end]))end++;
 const first=lines.findIndex((l,i)=>i>at&&i<end&&l.startsWith("|"));
 if(first<0){lines.splice(end,0,...[headers,headers.map(()=>"---"),...rows].map(r=>"| "+r.map(cell).join(" | ")+" |"),"");return lines.join(eol);}
 let last=first;while(last<end&&lines[last].startsWith("|"))last++;
 if(keepNotes){const notes=new Map(lines.slice(first+2,last).map(l=>{const c=l.split("|").slice(1,-1).map(x=>x.trim());return [c.slice(0,headers.length===6?2:1).join("|"),c.at(-1)??""]}));for(const r of rows){const key=r.slice(0,headers.length===6?2:1).join("|");if(notes.has(key))r[r.length-1]=notes.get(key)!;}}
 lines.splice(first,last-first,...[headers,headers.map(()=>"---"),...rows].map(r=>"| "+r.map(cell).join(" | ")+" |"));return lines.join(eol);
}
export function refreshCalendarIndex(index:string,kind:"desk"|"wall",files:Map<string,string>,root:string,today:string):string {
 if(kind==="wall"){
  const years=[...files].flatMap(([path,text])=>{const m=/\/(\d{4})\.md$/.exec(path);return path.startsWith(root+"/")&&m?[parseWallYear(text,+m[1])]:[]}).sort((a,b)=>a.year-b.year);
  let out=table(index,"연도별 요약",["연도","파일","예정","완료(`[x]`)","옮김(`[>]`·`→`)","취소(`[-]`·`~~`)","비고"],years.map(y=>{const c=countStatuses(y);return [String(y.year),`\`${y.year}.md\``,String(c.scheduled),String(c.done),String(c.moved),String(c.cancelled),""]}),true);
  out=table(out,"다가오는 일",["달","날짜","종류","내용","연결"],years.flatMap(y=>y.months.flatMap(m=>m.lines.filter(l=>l.item.status==="scheduled"&&`${y.year}-${String(m.month).padStart(2,"0")}`>=today.slice(0,7)).map(l=>[`${y.year}-${String(m.month).padStart(2,"0")}`,l.item.dateRaw||"달 중",l.item.kind==="task"?"할 일":l.item.kind==="event"?"행사":"메모",l.item.text,Object.fromEntries(l.item.fields).project||l.item.goal||"—"]))));return out;
 }
 const months=[...files].flatMap(([path,text])=>{const m=/\/(\d{4}-\d{2})\.md$/.exec(path);return path.startsWith(root+"/")&&m?[parseMonthFile(text,+m[1].slice(0,4),+m[1].slice(5,7))]:[]}).sort((a,b)=>a.key.localeCompare(b.key)),idx=dayIndex(months);
 let out=table(index,"달별 요약",["달","파일","예정","완료(`[x]`)","옮김(`[>]`·`→`)","취소(`[-]`·`~~`)","미배정","비고"],months.map(m=>{const s=summarizeMonth(m,idx),c=s.counts;return [m.key,`\`${m.year}/${m.key}.md\``,String(c.scheduled),String(c.done),String(c.moved),String(c.cancelled),String(s.unassigned),""]}),true);
 out=table(out,"주별 분배 칸",["달","주","기간","분배 항목","미배정","비고"],months.flatMap(m=>[...m.weeks.values()].map(w=>{const s=weekAllocStats(w);return [m.key,`W${String(w.no).padStart(2,"0")}`,`${mmdd(w.monday)}~${mmdd(addDays(w.monday,6))}`,w.alloc?String(s[0]):"—",w.alloc?String(s[1]):"—",""]})),true);
 out=table(out,"다가오는 일",["날짜","종류","내용","연결"],months.flatMap(m=>[...m.days].filter(([d])=>d>=today&&d<=addDays(today,13)).flatMap(([d,items])=>items.filter(t=>t.item.status==="scheduled").map(t=>[d,t.item.kind==="task"?"할 일":t.item.kind==="event"?"행사":"메모",[t.item.time,t.item.text].filter(Boolean).join(" "),Object.fromEntries(t.item.fields).project||t.item.goal||"—"]))));
 out=out.replace(/^## 다가오는 일[^\r\n]*/m,`## 다가오는 일 (${today}~${addDays(today,13)}, 예정 상태)`);return out;
}
