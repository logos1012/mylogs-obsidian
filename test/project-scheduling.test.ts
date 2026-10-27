import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hubTasks,calendarTasks,appendHubTask,replaceTaskLine,missingTaskRefs,taskTitle} from '../src/projects/tasks.ts';
import {newMonthSkeleton,parseMonthFile} from '../src/desk/model.ts';
import {refreshCalendarIndex} from '../src/projects/calendar-index.ts';
const today='2026-10-27',path='03 Desk Calendar/2026/2026-10.md';
test('unassigned tasks and references stay distinct, existing sections/CRLF preserved',()=>{
 const raw='---\r\nid: P-haru\r\n---\r\n\r\n## 할 일\r\n- [ ] 인터뷰 준비 (task:: T-one)\r\n- 창간호 발송 (task:: T-two)\r\n\r\n## 마일스톤\r\n- [ ] 발행 완료\r\n';
 assert.equal(hubTasks(raw,'p.md','P-haru').length,1);assert.equal(hubTasks(raw,'p.md','P-haru')[0].id,'T-one');
 const appended=appendHubTask(raw,'- [ ] 표지 검수 (task:: T-three)');assert.ok(!/(?<!\r)\n/.test(appended));assert.equal(hubTasks(appended,'p.md','P-haru').length,2);
 assert.deepEqual(missingTaskRefs(raw,hubTasks(raw,'p.md','P-haru')),['창간호 발송']);
 assert.throws(()=>replaceTaskLine(raw,{index:7,line:'wrong'},'changed'),/바뀌/);
});
test('task IDs distinguish identical titles and survive title changes',()=>{
 const raw=newMonthSkeleton(2026,10,today).replace('### 2026-10-28\n','### 2026-10-28\n- [ ] 초고 쓰기 (task:: T-a) (project:: P-a)\n- [ ] 초고 쓰기 (task:: T-b) (project:: P-b)\n');
 const day=parseMonthFile(raw,2026,10).days.get('2026-10-28')!;assert.notEqual(day[0].key,day[1].key);
 assert.equal(parseMonthFile(raw.replace('초고 쓰기','다른 제목'),2026,10).days.get('2026-10-28')![0].key,day[0].key);
 assert.equal(calendarTasks(raw,path,'desk','2026-10').filter(t=>t.projectId==='P-a').length,1);
});
test('registry tables recalculate counts, preserve user notes, and never count milestone projections',()=>{
 const raw=newMonthSkeleton(2026,10,today).replace('### 2026-10-28\n','### 2026-10-28\n- [x] 초고 쓰기 (task:: T-a) (project:: P-a)\n');
 const index='## 달별 요약\n\n사용자의 설명\n\n| 달 | 파일 | 예정 | 완료 | 옮김 | 취소 | 미배정 | 비고 |\n|---|---|---|---|---|---|---|---|\n| 2026-10 | `2026/2026-10.md` | 8 | 0 | 0 | 0 | 2 | 김하루가 남긴 메모 |\n';
 const out=refreshCalendarIndex(index,'desk',new Map([[path,raw]]),'03 Desk Calendar',today);
 assert.match(out,/\| 2026-10 \| `2026\/2026-10.md` \| 0 \| 1 \| 0 \| 0 \| 0 \| 김하루가 남긴 메모 \|/);assert.match(out,/사용자의 설명/);
 assert.equal(refreshCalendarIndex(out,'desk',new Map([[path,raw]]),'03 Desk Calendar',today),out);
});
test('task input rejects metadata injection/multiline and duplicate sections',()=>{
 for(const t of ['', 'a\nb','a (project:: P-other)','a → 10/28'])assert.throws(()=>taskTitle(t));
 assert.throws(()=>hubTasks('## 할 일\n\n## 할 일\n','p.md','P-a'),/여러 개/);
 assert.equal(taskTitle('  김하루의 초고  '),'김하루의 초고');
});
