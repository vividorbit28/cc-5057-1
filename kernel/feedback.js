// 内核反馈通道：UI 与生成器的失败都反馈回拼装内核，随清单一并保存
const feedbackLog = [];

export function recordFeedback(entry) {
  feedbackLog.push({ at: new Date().toISOString(), ...entry });
  return feedbackLog.length - 1;
}

export function getFeedback() {
  return feedbackLog.slice();
}

export function clearFeedback() {
  feedbackLog.length = 0;
}
