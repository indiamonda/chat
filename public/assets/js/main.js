// @ts-nocheck
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, uploadFile, getDefaultAvatarUrl } from './api.js';

if (typeof window !== 'undefined' && window.katex) {
  window.renderKatex = function (latex, displayMode) {
    return window.katex.renderToString(latex, { throwOnError: false, displayMode: !!displayMode });
  };
}

function applyTheme(theme) {
  const t = theme || state.theme || 'jimmyqrg';
  document.documentElement.setAttribute('data-theme', t);
}

let state = {
  user: null,
  users: [],
  group: null,
  panel: 'free_chat',
  dmUserId: null,
  convId: null,
  messages: {},
  socket: null,
  replyTo: null,
  inbox: [],
  friend_ids: [],
  blocked_ids: [],
  blacklisted: false,
  adminBlacklistedIds: [],
  supportMessageIdForSolve: null,
  leftBarExpanded: typeof localStorage !== 'undefined' && localStorage.getItem('leftBarExpanded') === '1',
  panelSearchOpen: false,
  profileUserId: null,
  editingDocKey: null,
  editingMessageId: null,
  messageVersionIndex: {},
  panelColumnExpanded: false,
  lastSeenByRoom: {},
  convByUserId: {},
  convIdToUserId: {},
  lastMessageAtByUserId: {},
  language: typeof localStorage !== 'undefined' ? (localStorage.getItem('language') || 'en') : 'en',
  theme: typeof localStorage !== 'undefined' ? (localStorage.getItem('theme') || 'jimmyqrg') : 'jimmyqrg',
  _recording: false,
  _recordingStream: null,
  _recordingRecorder: null,
  _recordingChunks: [],
  commandMode: typeof localStorage !== 'undefined' && localStorage.getItem('commandMode') === '1',
  notificationPrefs: null,
};

if (typeof document !== 'undefined' && document.documentElement) document.documentElement.setAttribute('lang', state.language || 'en');

/** Toast notifications (replacement for alert). type: 'error' | 'success' | 'info' */
function showToast(message, type = 'error') {
  if (typeof document === 'undefined') return;
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('toast--dismissed');
    setTimeout(() => el.remove(), 200);
  };
  setTimeout(dismiss, 4000);
  el.addEventListener('click', dismiss);
}

/** Fallback strings until data.json loads. Full translations in /assets/translation/data.json */
const DEFAULT_STRINGS = {
  en: {
    general: 'General',
    profile: 'Profile',
    account: 'Account',
    settings: 'Settings',
    theme: 'Theme',
    systemLanguage: 'System Language',
    chooseTheme: 'Choose the visual theme for the app.',
    chooseLanguage: 'Choose the display language for the app.',
    language: 'Language',
    password: 'Password',
    changePassword: 'Change password',
    changePasswordDesc: 'Change your password. Your current password is required.',
    signOut: 'Sign out',
    signOutDesc: 'Sign out of your account on this device.',
    home: 'Home',
    chat: 'Chat',
    inbox: 'Inbox',
    admin: 'Admin',
    expand: 'Expand',
    collapse: 'Collapse',
    dropImage: 'Drop image here or choose below',
    chooseImage: 'Choose image',
    displayName: 'Display name',
    username: 'Username',
    description: 'Description',
    descriptionPlaceholder: 'A short bio or description',
    website: 'Website',
    save: 'Save',
    avatar: 'Avatar',
    loading: 'Loading…',
    selectPanel: 'Select a panel.',
    selectConversation: 'Select a conversation.',
    noMailYet: 'No mail yet.',
    accept: 'Accept',
    reject: 'Reject',
    'delete': 'Delete',
    deleteMailConfirm: 'Delete this mail?',
    recording: 'Recording',
    cancel: 'Cancel',
    send: 'Send',
    currentPassword: 'Current password',
    newPassword: 'New password',
    confirmNewPassword: 'Confirm new password',
    atLeast6: 'At least 6 characters',
    confirmNewPasswordPlaceholder: 'Confirm new password',
    passwordChanged: 'Password changed.',
    fillCurrentNew: 'Please fill in current and new password.',
    newPasswordMin: 'New password must be at least 6 characters.',
    newPasswordMismatch: 'New password and confirmation do not match.',
    failedChangePassword: 'Failed to change password.',
    usernameOrEmail: 'Username or email',
    confirmPassword: 'Confirm password',
    email: 'Email',
    signUp: 'Sign up',
    login: 'Login',
    alreadyHaveAccount: 'Already have an account? ',
    noAccount: "Don't have an account? ",
    logIn: 'Log in',
    passwordRequired: 'Password is required',
    passwordsDoNotMatch: 'Passwords do not match',
    freeChat: 'Free Chat',
    support: 'Support',
    problemSolving: 'Problem Solving',
    rules: 'Rules',
    announcements: 'Announcements',
    action: 'Action',
    users: 'Users',
    recalled: 'Recalled',
    timeout: 'Time out',
    block: 'Block',
    unblock: 'Unblock',
    blocked: 'Blocked',
    sendFriendRequest: 'Send friend request',
    requestSent: 'Request sent',
    sendMessage: 'Send message',
    notifications: 'Notifications',
    notificationsDesc: 'Desktop notifications for messages and mail.',
    notifyMails: 'Mail (inbox)',
    notifyDm: 'Private messages',
    notifyGroup: 'Group messages',
    doNotDisturb: 'Do not disturb',
    dndSet: 'Set',
    dndCancel: 'Cancel',
    dndDays: 'Days',
    dndHours: 'Hours',
    dndMinutes: 'Minutes',
    dndSeconds: 'Seconds',
    dndEndNow: 'End DND now',
    dndAtNight: 'Do not disturb at night',
    dndUseLocation: 'Use my location',
    dndEnterCity: 'Enter city',
    dndCityHint: 'Enter your city to use its local time for night hours.',
    dndCityPlaceholder: 'e.g. New York, London',
    scrollToBottom: 'Scroll to bottom',
    notifModalTitle: 'Desktop notifications',
    notifModalDesc: 'Would you like to receive desktop notifications from this chat app on this device? You can change this later in Settings → Notifications.',
    notifModalAllow: 'Enable notifications',
    notifModalDecline: 'Not now',
    adminSendToInbox: 'Send to inbox',
    adminSendToInboxDesc: 'Send a message to a specific user\'s inbox.',
    adminBroadcast: 'Broadcast to all',
    adminBroadcastDesc: 'Send a message to every user\'s inbox.',
    adminTimeoutUser: 'Time out user',
    adminTimeoutDurationDesc: 'Prevent a user from sending messages in the JimmyQrg group chat for a set time.',
    adminTimeoutUserDesc: 'Prevent a user from sending messages in the JimmyQrg group chat.',
    adminSelectUser: 'Select user',
    adminTitle: 'Title',
    adminBody: 'Body',
    adminMessageBody: 'Message body',
    adminDuration: 'Duration',
    adminDurationPlaceholder: 'e.g. 5 minute, 1 hour, forever',
    adminOnlyICanRelease: 'Only I can release',
    adminNoPermissions: 'You have no action permissions. Ask an admin to grant Send mail, Broadcast, or Time out.',
    adminRecalledMessages: 'Recalled messages',
    adminRecalledDesc: 'Messages that were recalled by users in the group chat.',
    adminUsersSection: 'Users',
    adminUsersDesc: 'Add users to the admin list here. After adding someone, set what they are allowed to do (e.g. send mail, broadcast, edit docs).',
    adminPermSendMail: 'Send mail',
    adminPermBroadcast: 'Broadcast',
    adminPermEditDocs: 'Edit docs',
    adminPermRemoveAccount: 'Remove account',
    adminPermDeleteMessages: 'Delete messages',
    adminPermManageUsers: 'Manage users',
    adminPermTimeout: 'Time out',
    adminRoleAdmin: 'Admin',
    adminRoleDeleted: 'Deleted',
    adminRoleOnList: 'On admin list',
    adminRoleMember: 'Member',
    adminRemoveFromList: 'Remove from list',
    adminAddToList: 'Add to list',
    adminRestore: 'Restore',
    adminDeletePermanently: 'Delete permanently',
    adminRemoveAccount: 'Remove account',
    adminBlacklist: 'Blacklist',
    adminUnblacklist: 'Unblacklist',
    adminDeleteAccountTitle: 'Delete account permanently',
    adminDeleteAccountDesc: 'This will remove the user from the user list, remove them from private chat lists, and clear all data about them. This cannot be undone.',
    adminDeleteGroupMessages: 'Delete messages in group chat also',
    adminDeleteAdmin: 'Delete (admin)',
    adminRemoveAccountConfirm: 'Remove this account? The user will not be able to log in. Messages stay. You can restore later.',
    replyToMessage: 'Reply to message',
    recall: 'Recall',
    edit: 'Edit',
    solve: 'Solve',
    getFileId: 'Get file id',
    copy: 'Copy',
    reply: 'Reply',
    mentionDeletedUsers: 'Note: You\'re mentioning user(s) whose accounts have been deleted: ',
    adminNoRecalledMessages: 'No recalled messages.',
    adminFailedToLoad: 'Failed to load.',
    adminSent: 'Sent.',
    adminBroadcastSent: 'Broadcast sent.',
    adminNoActiveTimeouts: 'No active timeouts.',
    adminTimeoutUntil: 'until ',
    adminTimeoutForever: 'forever',
    adminTimeoutLocked: '(locked)',
    adminRelease: 'Release',
  }
};
let STRINGS = { ...DEFAULT_STRINGS };

async function loadTranslationData() {
  try {
    const r = await fetch('/assets/translation/data.json');
    const data = await r.json();
    if (data.strings) STRINGS = data.strings;
    if (data.languages) state.languageOptions = data.languages;
    setState({});
  } catch (e) { console.warn('Failed to load translations', e); }
}

function t(key) {
  const lang = state.language || 'en';
  const strings = STRINGS[lang] || STRINGS.en;
  return strings[key] != null ? strings[key] : (STRINGS.en[key] != null ? STRINGS.en[key] : key);
}

const _REMOVED_TRANSLATIONS = {
  zh: {
    profile: '个人资料',
    account: '账号',
    settings: '设置',
    theme: '主题',
    systemLanguage: '系统语言',
    chooseTheme: '选择应用的视觉主题。',
    chooseLanguage: '选择应用的显示语言。',
    language: '语言',
    password: '密码',
    changePassword: '修改密码',
    changePasswordDesc: '修改密码。需要输入当前密码。',
    signOut: '退出登录',
    signOutDesc: '在此设备上退出账号。',
    home: '首页',
    chat: '私信',
    inbox: '收件箱',
    admin: '管理',
    expand: '展开',
    collapse: '收起',
    dropImage: '将图片拖到此处或从下方选择',
    chooseImage: '选择图片',
    displayName: '显示名称',
    username: '用户名',
    description: '简介',
    descriptionPlaceholder: '简短介绍',
    website: '网站',
    save: '保存',
    avatar: '头像',
    loading: '加载中…',
    selectPanel: '请选择一个面板。',
    selectConversation: '请选择会话。',
    noMailYet: '暂无消息。',
    accept: '接受',
    reject: '拒绝',
    'delete': '删除',
    deleteMailConfirm: '删除此邮件？',
    recording: '录音中',
    cancel: '取消',
    send: '发送',
    currentPassword: '当前密码',
    newPassword: '新密码',
    confirmNewPassword: '确认新密码',
    atLeast6: '至少 6 个字符',
    confirmNewPasswordPlaceholder: '确认新密码',
    passwordChanged: '密码已修改。',
    fillCurrentNew: '请填写当前密码和新密码。',
    newPasswordMin: '新密码至少需要 6 个字符。',
    newPasswordMismatch: '新密码与确认不一致。',
    failedChangePassword: '修改密码失败。',
    usernameOrEmail: '用户名或邮箱',
    confirmPassword: '确认密码',
    email: '邮箱',
    signUp: '注册',
    login: '登录',
    alreadyHaveAccount: '已有账号？',
    noAccount: '没有账号？',
    logIn: '登录',
    passwordRequired: '请输入密码',
    passwordsDoNotMatch: '两次密码不一致',
    freeChat: '自由聊天',
    support: '求助',
    problemSolving: '帮助',
    rules: '规则',
    announcements: '公告',
    action: '操作',
    users: '用户',
    recalled: '已撤回',
    timeout: '禁言',
    block: '屏蔽',
    unblock: '取消屏蔽',
    blocked: '已屏蔽',
    sendFriendRequest: '发送好友请求',
    requestSent: '已发送',
    sendMessage: '发送消息',
    notifications: '通知',
    notificationsDesc: '桌面通知，用于消息和邮件。',
    notifyMails: '邮件（收件箱）',
    notifyDm: '私信',
    notifyGroup: '群组消息',
    doNotDisturb: '勿扰模式',
    dndSet: '设置',
    dndCancel: '取消',
    dndDays: '天',
    dndHours: '小时',
    dndMinutes: '分钟',
    dndSeconds: '秒',
    dndEndNow: '立即结束勿扰',
    dndAtNight: '夜间勿扰',
    dndUseLocation: '使用我的位置',
    dndEnterCity: '输入城市',
    dndCityHint: '输入城市以使用其本地时间判断夜间。',
    dndCityPlaceholder: '例如：北京、上海',
    scrollToBottom: '滚动到底部',
    notifModalTitle: '桌面通知',
    notifModalDesc: '是否要在此设备上接收此聊天应用的桌面通知？您可以在设置 → 通知中稍后更改。',
    notifModalAllow: '启用通知',
    notifModalDecline: '暂不',
    adminSendToInbox: '发送到收件箱',
    adminSendToInboxDesc: '向指定用户的收件箱发送消息。',
    adminBroadcast: '广播给所有人',
    adminBroadcastDesc: '向所有用户的收件箱发送消息。',
    adminTimeoutUser: '禁言用户',
    adminTimeoutDurationDesc: '在一段时间内禁止该用户在 JimmyQrg 群聊中发送消息。',
    adminTimeoutUserDesc: '禁止该用户在 JimmyQrg 群聊中发送消息。',
    adminSelectUser: '选择用户',
    adminTitle: '标题',
    adminBody: '正文',
    adminMessageBody: '消息正文',
    adminDuration: '时长',
    adminDurationPlaceholder: '例如：5 分钟、1 小时、永久',
    adminOnlyICanRelease: '仅我可解除',
    adminNoPermissions: '您没有操作权限。请让管理员授予发送邮件、广播或禁言权限。',
    adminRecalledMessages: '已撤回的消息',
    adminRecalledDesc: '群聊中用户已撤回的消息记录。',
    adminUsersSection: '用户',
    adminUsersDesc: '在此添加管理员。添加后，可设置其权限（如发邮件、广播、编辑文档等）。',
    adminPermSendMail: '发邮件',
    adminPermBroadcast: '广播',
    adminPermEditDocs: '编辑文档',
    adminPermRemoveAccount: '移除账号',
    adminPermDeleteMessages: '删除消息',
    adminPermManageUsers: '管理用户',
    adminPermTimeout: '禁言',
    adminRoleAdmin: '管理员',
    adminRoleDeleted: '已删除',
    adminRoleOnList: '在管理员列表中',
    adminRoleMember: '成员',
    adminRemoveFromList: '移出列表',
    adminAddToList: '加入列表',
    adminRestore: '恢复',
    adminDeletePermanently: '永久删除',
    adminRemoveAccount: '移除账号',
    adminBlacklist: '拉黑',
    adminUnblacklist: '取消拉黑',
    adminDeleteAccountTitle: '永久删除账号',
    adminDeleteAccountDesc: '将把该用户从用户列表中移除，从私聊列表中移除，并清除其所有数据。此操作不可撤销。',
    adminDeleteGroupMessages: '同时删除群聊中的消息',
    adminDeleteAdmin: '删除（管理员）',
    adminRemoveAccountConfirm: '确定要移除此账号吗？用户将无法登录。消息会保留，之后可恢复。',
    replyToMessage: '回复消息',
    recall: '撤回',
    edit: '编辑',
    solve: '标记已解决',
    getFileId: '获取文件 ID',
    copy: '复制',
    reply: '回复',
    mentionDeletedUsers: '提示：您正在提及已删除账号的用户：',
    adminNoRecalledMessages: '暂无已撤回的消息。',
    adminFailedToLoad: '加载失败。',
    adminSent: '已发送。',
    adminBroadcastSent: '广播已发送。',
    adminNoActiveTimeouts: '暂无禁言中的用户。',
    adminTimeoutUntil: '至 ',
    adminTimeoutForever: '永久',
    adminTimeoutLocked: '（仅我可解除）',
    adminRelease: '解除',
  },
  'ja': {
    general: '一般',
    profile: 'プロフィール',
    account: 'アカウント',
    settings: '設定',
    theme: 'テーマ',
    systemLanguage: 'システム言語',
    chooseTheme: 'アプリの表示テーマを選択します。',
    chooseLanguage: 'アプリの表示言語を選択します。',
    language: '言語',
    password: 'パスワード',
    changePassword: 'パスワードを変更',
    changePasswordDesc: 'パスワードを変更します。現在のパスワードが必要です。',
    signOut: 'ログアウト',
    signOutDesc: 'このデバイスからログアウトします。',
    home: 'ホーム',
    chat: 'チャット',
    inbox: '受信トレイ',
    admin: '管理',
    expand: '展開',
    collapse: '折りたたむ',
    dropImage: '画像をここにドロップするか、下から選択',
    chooseImage: '画像を選択',
    displayName: '表示名',
    username: 'ユーザー名',
    description: '自己紹介',
    descriptionPlaceholder: '短い自己紹介',
    website: 'ウェブサイト',
    save: '保存',
    avatar: 'アバター',
    loading: '読み込み中…',
    selectPanel: 'パネルを選択してください。',
    selectConversation: '会話を選択してください。',
    noMailYet: 'メールはまだありません。',
    accept: '承諾',
    reject: '拒否',
    'delete': '削除',
    deleteMailConfirm: 'このメールを削除しますか？',
    recording: '録音中',
    cancel: 'キャンセル',
    send: '送信',
    currentPassword: '現在のパスワード',
    newPassword: '新しいパスワード',
    confirmNewPassword: '新しいパスワードの確認',
    atLeast6: '6文字以上',
    confirmNewPasswordPlaceholder: '新しいパスワードの確認',
    passwordChanged: 'パスワードを変更しました。',
    fillCurrentNew: '現在のパスワードと新しいパスワードを入力してください。',
    newPasswordMin: '新しいパスワードは6文字以上にしてください。',
    newPasswordMismatch: '新しいパスワードと確認が一致しません。',
    failedChangePassword: 'パスワードの変更に失敗しました。',
    usernameOrEmail: 'ユーザー名またはメール',
    confirmPassword: 'パスワードの確認',
    email: 'メール',
    signUp: '登録',
    login: 'ログイン',
    alreadyHaveAccount: 'すでにアカウントをお持ちですか？',
    noAccount: 'アカウントをお持ちでないですか？',
    logIn: 'ログイン',
    passwordRequired: 'パスワードを入力してください',
    passwordsDoNotMatch: 'パスワードが一致しません',
    freeChat: 'フリーチャット',
    support: 'サポート',
    problemSolving: '問題解決',
    rules: 'ルール',
    announcements: 'お知らせ',
    action: '操作',
    users: 'ユーザー',
    recalled: '取り消し',
    timeout: 'タイムアウト',
    notifications: '通知',
    notificationsDesc: 'メッセージとメールのデスクトップ通知。',
    notifyMails: 'メール（受信トレイ）',
    notifyDm: 'プライベートメッセージ',
    notifyGroup: 'グループメッセージ',
    doNotDisturb: 'おやすみモード',
    dndSet: '設定',
    dndCancel: 'キャンセル',
    dndDays: '日',
    dndHours: '時間',
    dndMinutes: '分',
    dndSeconds: '秒',
    dndEndNow: 'おやすみモードを終了',
    dndAtNight: '夜間おやすみモード',
    dndUseLocation: '現在地を使用',
    dndEnterCity: '都市を入力',
    dndCityHint: '都市を入力すると、その地域の現地時間で夜間を判定します。',
    dndCityPlaceholder: '例：東京、大阪',
    scrollToBottom: '一番下へ',
    notifModalTitle: 'デスクトップ通知',
    notifModalDesc: 'このチャットアプリのデスクトップ通知をこのデバイスで受け取りますか？設定 → 通知で後から変更できます。',
    notifModalAllow: '通知を有効にする',
    notifModalDecline: '後で',
    adminSendToInbox: '受信トレイに送信',
    adminSendToInboxDesc: '特定のユーザーの受信トレイにメッセージを送信します。',
    adminBroadcast: '全員に一斉送信',
    adminBroadcastDesc: '全ユーザーの受信トレイにメッセージを送信します。',
    adminTimeoutUser: 'ユーザーをミュート',
    adminTimeoutDurationDesc: '指定時間、JimmyQrg グループチャットでメッセージを送信できなくします。',
    adminTimeoutUserDesc: 'JimmyQrg グループチャットでメッセージを送信できなくします。',
    adminSelectUser: 'ユーザーを選択',
    adminTitle: 'タイトル',
    adminBody: '本文',
    adminMessageBody: 'メッセージ本文',
    adminDuration: '期間',
    adminDurationPlaceholder: '例：5分、1時間、永久',
    adminOnlyICanRelease: '解除は自分だけ',
    adminNoPermissions: '操作権限がありません。管理者にメール送信・一斉送信・ミュートの権限を付与してもらってください。',
    adminRecalledMessages: '取り消されたメッセージ',
    adminRecalledDesc: 'グループチャットでユーザーが取り消したメッセージの記録。',
    adminUsersSection: 'ユーザー',
    adminUsersDesc: 'ここで管理者を追加します。追加後、許可する操作（メール送信、一斉送信、ドキュメント編集など）を設定できます。',
    adminPermSendMail: 'メール送信',
    adminPermBroadcast: '一斉送信',
    adminPermEditDocs: 'ドキュメント編集',
    adminPermRemoveAccount: 'アカウント削除',
    adminPermDeleteMessages: 'メッセージ削除',
    adminPermManageUsers: 'ユーザー管理',
    adminPermTimeout: 'ミュート',
    adminRoleAdmin: '管理者',
    adminRoleDeleted: '削除済み',
    adminRoleOnList: '管理者リストに登録',
    adminRoleMember: 'メンバー',
    adminRemoveFromList: 'リストから削除',
    adminAddToList: 'リストに追加',
    adminRestore: '復元',
    adminDeletePermanently: '完全に削除',
    adminRemoveAccount: 'アカウント削除',
    adminBlacklist: 'ブラックリスト',
    adminUnblacklist: 'ブラックリスト解除',
    adminDeleteAccountTitle: 'アカウントを完全に削除',
    adminDeleteAccountDesc: 'ユーザーをユーザーリストから削除し、プライベートチャットリストから削除し、関連するすべてのデータを消去します。元に戻せません。',
    adminDeleteGroupMessages: 'グループチャットのメッセージも削除',
    adminDeleteAdmin: '削除（管理者）',
    adminRemoveAccountConfirm: 'このアカウントを削除しますか？ユーザーはログインできなくなります。メッセージは残り、後で復元できます。',
    replyToMessage: 'メッセージに返信',
    recall: '取り消す',
    edit: '編集',
    solve: '解決済みにする',
    getFileId: 'ファイルIDを取得',
    copy: 'コピー',
    reply: '返信',
    mentionDeletedUsers: '注意：削除済みアカウントのユーザーをメンションしています：',
    adminNoRecalledMessages: '取り消されたメッセージはありません。',
    adminFailedToLoad: '読み込みに失敗しました。',
    adminSent: '送信しました。',
    adminBroadcastSent: '一斉送信しました。',
    adminNoActiveTimeouts: 'ミュート中のユーザーはいません。',
    adminTimeoutUntil: 'まで ',
    adminTimeoutForever: '永久',
    adminTimeoutLocked: '（解除は自分だけ）',
    adminRelease: '解除',
    block: 'ブロック',
    unblock: 'ブロック解除',
    blocked: 'ブロック済み',
    sendFriendRequest: '友達リクエストを送る',
    requestSent: 'リクエスト送信済み',
    sendMessage: 'メッセージを送る',
  },
  'ko': {
    general: '일반',
    profile: '프로필',
    account: '계정',
    settings: '설정',
    theme: '테마',
    systemLanguage: '시스템 언어',
    chooseTheme: '앱의 테마를 선택하세요.',
    chooseLanguage: '앱의 표시 언어를 선택하세요.',
    language: '언어',
    password: '비밀번호',
    changePassword: '비밀번호 변경',
    changePasswordDesc: '비밀번호를 변경합니다. 현재 비밀번호가 필요합니다.',
    signOut: '로그아웃',
    signOutDesc: '이 기기에서 로그아웃합니다.',
    home: '홈',
    chat: '채팅',
    inbox: '받은편지함',
    admin: '관리',
    expand: '펼치기',
    collapse: '접기',
    dropImage: '이미지를 여기에 놓거나 아래에서 선택',
    chooseImage: '이미지 선택',
    displayName: '표시 이름',
    username: '사용자 이름',
    description: '소개',
    descriptionPlaceholder: '간단한 소개',
    website: '웹사이트',
    save: '저장',
    avatar: '아바타',
    loading: '로딩 중…',
    selectPanel: '패널을 선택하세요.',
    selectConversation: '대화를 선택하세요.',
    noMailYet: '메일이 없습니다.',
    accept: '수락',
    reject: '거절',
    'delete': '삭제',
    deleteMailConfirm: '이 메일을 삭제하시겠습니까?',
    recording: '녹음 중',
    cancel: '취소',
    send: '보내기',
    currentPassword: '현재 비밀번호',
    newPassword: '새 비밀번호',
    confirmNewPassword: '새 비밀번호 확인',
    atLeast6: '6자 이상',
    confirmNewPasswordPlaceholder: '새 비밀번호 확인',
    passwordChanged: '비밀번호가 변경되었습니다.',
    fillCurrentNew: '현재 비밀번호와 새 비밀번호를 입력하세요.',
    newPasswordMin: '새 비밀번호는 6자 이상이어야 합니다.',
    newPasswordMismatch: '새 비밀번호와 확인이 일치하지 않습니다.',
    failedChangePassword: '비밀번호 변경에 실패했습니다.',
    usernameOrEmail: '사용자 이름 또는 이메일',
    confirmPassword: '비밀번호 확인',
    email: '이메일',
    signUp: '가입',
    login: '로그인',
    alreadyHaveAccount: '이미 계정이 있으신가요? ',
    noAccount: '계정이 없으신가요? ',
    logIn: '로그인',
    passwordRequired: '비밀번호를 입력하세요',
    passwordsDoNotMatch: '비밀번호가 일치하지 않습니다',
    freeChat: '자유 채팅',
    support: '지원',
    problemSolving: '문제 해결',
    rules: '규칙',
    announcements: '공지',
    action: '작업',
    users: '사용자',
    recalled: '취소됨',
    timeout: '타임아웃',
    notifications: '알림',
    notificationsDesc: '메시지 및 메일용 데스크톱 알림.',
    notifyMails: '메일(받은편지함)',
    notifyDm: '개인 메시지',
    notifyGroup: '그룹 메시지',
    doNotDisturb: '방해 금지',
    dndSet: '설정',
    dndCancel: '취소',
    dndDays: '일',
    dndHours: '시간',
    dndMinutes: '분',
    dndSeconds: '초',
    dndEndNow: '방해 금지 종료',
    dndAtNight: '야간 방해 금지',
    dndUseLocation: '내 위치 사용',
    dndEnterCity: '도시 입력',
    dndCityHint: '도시를 입력하면 해당 지역의 현지 시간으로 야간을 판단합니다.',
    dndCityPlaceholder: '예: 서울, 부산',
    scrollToBottom: '맨 아래로',
    block: '차단',
    unblock: '차단 해제',
    blocked: '차단됨',
    sendFriendRequest: '친구 요청 보내기',
    requestSent: '요청 보냄',
    sendMessage: '메시지 보내기',
    notifModalTitle: '데스크톱 알림',
    notifModalDesc: '이 채팅 앱의 데스크톱 알림을 이 기기에서 받으시겠습니까? 설정 → 알림에서 나중에 변경할 수 있습니다.',
    notifModalAllow: '알림 사용',
    notifModalDecline: '나중에',
    adminSendToInbox: '받은편지함으로 보내기',
    adminSendToInboxDesc: '특정 사용자의 받은편지함에 메시지를 보냅니다.',
    adminBroadcast: '전체 공지',
    adminBroadcastDesc: '모든 사용자의 받은편지함에 메시지를 보냅니다.',
    adminTimeoutUser: '사용자 채팅 금지',
    adminTimeoutDurationDesc: '지정한 시간 동안 JimmyQrg 그룹 채팅에서 메시지 전송을 막습니다.',
    adminTimeoutUserDesc: 'JimmyQrg 그룹 채팅에서 메시지 전송을 막습니다.',
    adminSelectUser: '사용자 선택',
    adminTitle: '제목',
    adminBody: '본문',
    adminMessageBody: '메시지 본문',
    adminDuration: '기간',
    adminDurationPlaceholder: '예: 5분, 1시간, 영구',
    adminOnlyICanRelease: '해제는 본인만 가능',
    adminNoPermissions: '작업 권한이 없습니다. 관리자에게 메일 발송, 공지, 채팅 금지 권한을 요청하세요.',
    adminRecalledMessages: '취소된 메시지',
    adminRecalledDesc: '그룹 채팅에서 사용자가 취소한 메시지 기록입니다.',
    adminUsersSection: '사용자',
    adminUsersDesc: '여기서 관리자를 추가합니다. 추가 후 허용할 작업(메일 발송, 공지, 문서 편집 등)을 설정하세요.',
    adminPermSendMail: '메일 발송',
    adminPermBroadcast: '공지',
    adminPermEditDocs: '문서 편집',
    adminPermRemoveAccount: '계정 삭제',
    adminPermDeleteMessages: '메시지 삭제',
    adminPermManageUsers: '사용자 관리',
    adminPermTimeout: '채팅 금지',
    adminRoleAdmin: '관리자',
    adminRoleDeleted: '삭제됨',
    adminRoleOnList: '관리자 목록',
    adminRoleMember: '멤버',
    adminRemoveFromList: '목록에서 제거',
    adminAddToList: '목록에 추가',
    adminRestore: '복원',
    adminDeletePermanently: '영구 삭제',
    adminRemoveAccount: '계정 삭제',
    adminBlacklist: '차단 목록',
    adminUnblacklist: '차단 해제',
    adminDeleteAccountTitle: '계정 영구 삭제',
    adminDeleteAccountDesc: '사용자를 사용자 목록에서 제거하고, 개인 채팅 목록에서 제거하며, 관련 데이터를 모두 삭제합니다. 되돌릴 수 없습니다.',
    adminDeleteGroupMessages: '그룹 채팅 메시지도 삭제',
    adminDeleteAdmin: '삭제(관리자)',
    adminRemoveAccountConfirm: '이 계정을 삭제하시겠습니까? 사용자는 로그인할 수 없습니다. 메시지는 유지되며 나중에 복원할 수 있습니다.',
    replyToMessage: '메시지에 답장',
    recall: '취소',
    edit: '편집',
    solve: '해결됨으로 표시',
    getFileId: '파일 ID 가져오기',
    copy: '복사',
    reply: '답장',
    mentionDeletedUsers: '참고: 삭제된 계정의 사용자를 멘션하고 있습니다: ',
    adminNoRecalledMessages: '취소된 메시지가 없습니다.',
    adminFailedToLoad: '로드에 실패했습니다.',
    adminSent: '전송되었습니다.',
    adminBroadcastSent: '공지가 전송되었습니다.',
    adminNoActiveTimeouts: '채팅 금지 중인 사용자가 없습니다.',
    adminTimeoutUntil: '까지 ',
    adminTimeoutForever: '영구',
    adminTimeoutLocked: '(해제는 본인만)',
    adminRelease: '해제',
  },
  'es': {
    general: 'General',
    profile: 'Perfil',
    account: 'Cuenta',
    settings: 'Ajustes',
    theme: 'Tema',
    systemLanguage: 'Idioma del sistema',
    chooseTheme: 'Elige el tema visual de la aplicación.',
    chooseLanguage: 'Elige el idioma de visualización de la aplicación.',
    language: 'Idioma',
    password: 'Contraseña',
    changePassword: 'Cambiar contraseña',
    changePasswordDesc: 'Cambia tu contraseña. Se requiere la contraseña actual.',
    signOut: 'Cerrar sesión',
    signOutDesc: 'Cerrar sesión en este dispositivo.',
    home: 'Inicio',
    chat: 'Chat',
    inbox: 'Bandeja de entrada',
    admin: 'Administración',
    expand: 'Expandir',
    collapse: 'Contraer',
    dropImage: 'Suelta la imagen aquí o elige abajo',
    chooseImage: 'Elegir imagen',
    displayName: 'Nombre para mostrar',
    username: 'Nombre de usuario',
    description: 'Descripción',
    descriptionPlaceholder: 'Una breve biografía o descripción',
    website: 'Sitio web',
    save: 'Guardar',
    avatar: 'Avatar',
    loading: 'Cargando…',
    selectPanel: 'Selecciona un panel.',
    selectConversation: 'Selecciona una conversación.',
    noMailYet: 'Aún no hay correo.',
    accept: 'Aceptar',
    reject: 'Rechazar',
    'delete': 'Eliminar',
    deleteMailConfirm: '¿Eliminar este correo?',
    recording: 'Grabando',
    cancel: 'Cancelar',
    send: 'Enviar',
    currentPassword: 'Contraseña actual',
    newPassword: 'Nueva contraseña',
    confirmNewPassword: 'Confirmar nueva contraseña',
    atLeast6: 'Al menos 6 caracteres',
    confirmNewPasswordPlaceholder: 'Confirmar nueva contraseña',
    passwordChanged: 'Contraseña cambiada.',
    fillCurrentNew: 'Por favor, introduce la contraseña actual y la nueva.',
    newPasswordMin: 'La nueva contraseña debe tener al menos 6 caracteres.',
    newPasswordMismatch: 'La nueva contraseña y la confirmación no coinciden.',
    failedChangePassword: 'Error al cambiar la contraseña.',
    usernameOrEmail: 'Nombre de usuario o correo',
    confirmPassword: 'Confirmar contraseña',
    email: 'Correo electrónico',
    signUp: 'Registrarse',
    login: 'Iniciar sesión',
    alreadyHaveAccount: '¿Ya tienes una cuenta? ',
    noAccount: '¿No tienes una cuenta? ',
    logIn: 'Iniciar sesión',
    passwordRequired: 'La contraseña es obligatoria',
    passwordsDoNotMatch: 'Las contraseñas no coinciden',
    freeChat: 'Chat libre',
    support: 'Soporte',
    problemSolving: 'Resolución de problemas',
    rules: 'Reglas',
    announcements: 'Anuncios',
    action: 'Acción',
    users: 'Usuarios',
    recalled: 'Recuperado',
    timeout: 'Tiempo de espera',
    block: 'Bloquear',
    unblock: 'Desbloquear',
    blocked: 'Bloqueado',
    sendFriendRequest: 'Enviar solicitud de amistad',
    requestSent: 'Solicitud enviada',
    sendMessage: 'Enviar mensaje',
    notifications: 'Notificaciones',
    notificationsDesc: 'Notificaciones de escritorio para mensajes y correo.',
    notifyMails: 'Correo (bandeja de entrada)',
    notifyDm: 'Mensajes privados',
    notifyGroup: 'Mensajes de grupo',
    doNotDisturb: 'No molestar',
    dndSet: 'Establecer',
    dndCancel: 'Cancelar',
    dndDays: 'Días',
    dndHours: 'Horas',
    dndMinutes: 'Minutos',
    dndSeconds: 'Segundos',
    dndEndNow: 'Terminar no molestar ahora',
    dndAtNight: 'No molestar por la noche',
    dndUseLocation: 'Usar mi ubicación',
    dndEnterCity: 'Introducir ciudad',
    dndCityHint: 'Introduce tu ciudad para usar su hora local en el horario nocturno.',
    dndCityPlaceholder: 'ej. Madrid, Barcelona',
    scrollToBottom: 'Ir al final',
    notifModalTitle: 'Notificaciones de escritorio',
    notifModalDesc: '¿Quieres recibir notificaciones de escritorio de esta aplicación de chat en este dispositivo? Puedes cambiarlo más tarde en Ajustes → Notificaciones.',
    notifModalAllow: 'Activar notificaciones',
    notifModalDecline: 'Ahora no',
    adminSendToInbox: 'Enviar a bandeja de entrada',
    adminSendToInboxDesc: 'Enviar un mensaje a la bandeja de entrada de un usuario específico.',
    adminBroadcast: 'Transmitir a todos',
    adminBroadcastDesc: 'Enviar un mensaje a la bandeja de entrada de todos los usuarios.',
    adminTimeoutUser: 'Silenciar usuario',
    adminTimeoutDurationDesc: 'Impedir que un usuario envíe mensajes en el chat grupal JimmyQrg durante un tiempo determinado.',
    adminTimeoutUserDesc: 'Impedir que un usuario envíe mensajes en el chat grupal JimmyQrg.',
    adminSelectUser: 'Seleccionar usuario',
    adminTitle: 'Título',
    adminBody: 'Cuerpo',
    adminMessageBody: 'Cuerpo del mensaje',
    adminDuration: 'Duración',
    adminDurationPlaceholder: 'ej. 5 minutos, 1 hora, para siempre',
    adminOnlyICanRelease: 'Solo yo puedo liberar',
    adminNoPermissions: 'No tienes permisos de acción. Pide a un administrador que te conceda Enviar correo, Transmitir o Silenciar.',
    adminRecalledMessages: 'Mensajes recuperados',
    adminRecalledDesc: 'Mensajes que los usuarios recuperaron en el chat grupal.',
    adminUsersSection: 'Usuarios',
    adminUsersDesc: 'Añade usuarios a la lista de administradores aquí. Después de añadir a alguien, configura qué puede hacer (ej. enviar correo, transmitir, editar documentos).',
    adminPermSendMail: 'Enviar correo',
    adminPermBroadcast: 'Transmitir',
    adminPermEditDocs: 'Editar documentos',
    adminPermRemoveAccount: 'Eliminar cuenta',
    adminPermDeleteMessages: 'Eliminar mensajes',
    adminPermManageUsers: 'Gestionar usuarios',
    adminPermTimeout: 'Silenciar',
    adminRoleAdmin: 'Administrador',
    adminRoleDeleted: 'Eliminado',
    adminRoleOnList: 'En lista de administradores',
    adminRoleMember: 'Miembro',
    adminRemoveFromList: 'Quitar de la lista',
    adminAddToList: 'Añadir a la lista',
    adminRestore: 'Restaurar',
    adminDeletePermanently: 'Eliminar permanentemente',
    adminRemoveAccount: 'Eliminar cuenta',
    adminBlacklist: 'Lista negra',
    adminUnblacklist: 'Quitar de lista negra',
    adminDeleteAccountTitle: 'Eliminar cuenta permanentemente',
    adminDeleteAccountDesc: 'Esto eliminará al usuario de la lista, lo quitará de las listas de chat privado y borrará todos sus datos. No se puede deshacer.',
    adminDeleteGroupMessages: 'Eliminar también los mensajes del chat grupal',
    adminDeleteAdmin: 'Eliminar (admin)',
    adminRemoveAccountConfirm: '¿Eliminar esta cuenta? El usuario no podrá iniciar sesión. Los mensajes permanecen. Puedes restaurar más tarde.',
    replyToMessage: 'Responder al mensaje',
    recall: 'Recuperar',
    edit: 'Editar',
    solve: 'Marcar como resuelto',
    getFileId: 'Obtener ID de archivo',
    copy: 'Copiar',
    reply: 'Responder',
    mentionDeletedUsers: 'Nota: Estás mencionando usuario(s) cuyas cuentas han sido eliminadas: ',
    adminNoRecalledMessages: 'No hay mensajes recuperados.',
    adminFailedToLoad: 'Error al cargar.',
    adminSent: 'Enviado.',
    adminBroadcastSent: 'Transmisión enviada.',
    adminNoActiveTimeouts: 'No hay silenciamientos activos.',
    adminTimeoutUntil: 'hasta ',
    adminTimeoutForever: 'para siempre',
    adminTimeoutLocked: '(bloqueado)',
    adminRelease: 'Liberar',
  },
  'fr': {
    general: 'Général',
    profile: 'Profil',
    account: 'Compte',
    settings: 'Paramètres',
    theme: 'Thème',
    systemLanguage: 'Langue du système',
    chooseTheme: 'Choisissez le thème visuel de l\'application.',
    chooseLanguage: 'Choisissez la langue d\'affichage de l\'application.',
    language: 'Langue',
    password: 'Mot de passe',
    changePassword: 'Changer le mot de passe',
    changePasswordDesc: 'Changez votre mot de passe. Votre mot de passe actuel est requis.',
    signOut: 'Déconnexion',
    signOutDesc: 'Se déconnecter de ce périphérique.',
    home: 'Accueil',
    chat: 'Chat',
    inbox: 'Boîte de réception',
    admin: 'Administration',
    expand: 'Développer',
    collapse: 'Réduire',
    dropImage: 'Déposez l\'image ici ou choisissez ci-dessous',
    chooseImage: 'Choisir une image',
    displayName: 'Nom d\'affichage',
    username: 'Nom d\'utilisateur',
    description: 'Description',
    descriptionPlaceholder: 'Une courte biographie ou description',
    website: 'Site web',
    save: 'Enregistrer',
    avatar: 'Avatar',
    loading: 'Chargement…',
    selectPanel: 'Sélectionnez un panneau.',
    selectConversation: 'Sélectionnez une conversation.',
    noMailYet: 'Pas encore de courrier.',
    accept: 'Accepter',
    reject: 'Refuser',
    'delete': 'Supprimer',
    deleteMailConfirm: 'Supprimer ce courrier ?',
    recording: 'Enregistrement',
    cancel: 'Annuler',
    send: 'Envoyer',
    currentPassword: 'Mot de passe actuel',
    newPassword: 'Nouveau mot de passe',
    confirmNewPassword: 'Confirmer le nouveau mot de passe',
    atLeast6: 'Au moins 6 caractères',
    confirmNewPasswordPlaceholder: 'Confirmer le nouveau mot de passe',
    passwordChanged: 'Mot de passe modifié.',
    fillCurrentNew: 'Veuillez remplir le mot de passe actuel et le nouveau.',
    newPasswordMin: 'Le nouveau mot de passe doit contenir au moins 6 caractères.',
    newPasswordMismatch: 'Le nouveau mot de passe et la confirmation ne correspondent pas.',
    failedChangePassword: 'Échec du changement de mot de passe.',
    usernameOrEmail: 'Nom d\'utilisateur ou e-mail',
    confirmPassword: 'Confirmer le mot de passe',
    email: 'E-mail',
    signUp: 'S\'inscrire',
    login: 'Connexion',
    alreadyHaveAccount: 'Vous avez déjà un compte ? ',
    noAccount: 'Vous n\'avez pas de compte ? ',
    logIn: 'Se connecter',
    passwordRequired: 'Le mot de passe est requis',
    passwordsDoNotMatch: 'Les mots de passe ne correspondent pas',
    freeChat: 'Chat libre',
    support: 'Support',
    problemSolving: 'Résolution de problèmes',
    rules: 'Règles',
    announcements: 'Annonces',
    action: 'Action',
    users: 'Utilisateurs',
    recalled: 'Récupéré',
    timeout: 'Temps mort',
    block: 'Bloquer',
    unblock: 'Débloquer',
    blocked: 'Bloqué',
    sendFriendRequest: 'Envoyer une demande d\'ami',
    requestSent: 'Demande envoyée',
    sendMessage: 'Envoyer un message',
    notifications: 'Notifications',
    notificationsDesc: 'Notifications de bureau pour les messages et le courrier.',
    notifyMails: 'Courrier (boîte de réception)',
    notifyDm: 'Messages privés',
    notifyGroup: 'Messages de groupe',
    doNotDisturb: 'Ne pas déranger',
    dndSet: 'Définir',
    dndCancel: 'Annuler',
    dndDays: 'Jours',
    dndHours: 'Heures',
    dndMinutes: 'Minutes',
    dndSeconds: 'Secondes',
    dndEndNow: 'Terminer NPD maintenant',
    dndAtNight: 'Ne pas déranger la nuit',
    dndUseLocation: 'Utiliser ma position',
    dndEnterCity: 'Entrer la ville',
    dndCityHint: 'Entrez votre ville pour utiliser son heure locale pour les heures nocturnes.',
    dndCityPlaceholder: 'ex. Paris, Lyon',
    scrollToBottom: 'Aller en bas',
    notifModalTitle: 'Notifications de bureau',
    notifModalDesc: 'Voulez-vous recevoir les notifications de bureau de cette application de chat sur ce périphérique ? Vous pouvez modifier cela plus tard dans Paramètres → Notifications.',
    notifModalAllow: 'Activer les notifications',
    notifModalDecline: 'Pas maintenant',
    adminSendToInbox: 'Envoyer à la boîte de réception',
    adminSendToInboxDesc: 'Envoyer un message à la boîte de réception d\'un utilisateur spécifique.',
    adminBroadcast: 'Diffuser à tous',
    adminBroadcastDesc: 'Envoyer un message à la boîte de réception de tous les utilisateurs.',
    adminTimeoutUser: 'Mettre en sourdine un utilisateur',
    adminTimeoutDurationDesc: 'Empêcher un utilisateur d\'envoyer des messages dans le chat de groupe JimmyQrg pendant une durée déterminée.',
    adminTimeoutUserDesc: 'Empêcher un utilisateur d\'envoyer des messages dans le chat de groupe JimmyQrg.',
    adminSelectUser: 'Sélectionner un utilisateur',
    adminTitle: 'Titre',
    adminBody: 'Corps',
    adminMessageBody: 'Corps du message',
    adminDuration: 'Durée',
    adminDurationPlaceholder: 'ex. 5 minutes, 1 heure, pour toujours',
    adminOnlyICanRelease: 'Seul je peux libérer',
    adminNoPermissions: 'Vous n\'avez pas les permissions d\'action. Demandez à un administrateur d\'accorder Envoyer du courrier, Diffuser ou Mettre en sourdine.',
    adminRecalledMessages: 'Messages récupérés',
    adminRecalledDesc: 'Messages qui ont été récupérés par les utilisateurs dans le chat de groupe.',
    adminUsersSection: 'Utilisateurs',
    adminUsersDesc: 'Ajoutez des utilisateurs à la liste des administrateurs ici. Après en avoir ajouté un, définissez ce qu\'il peut faire (ex. envoyer du courrier, diffuser, modifier des documents).',
    adminPermSendMail: 'Envoyer du courrier',
    adminPermBroadcast: 'Diffuser',
    adminPermEditDocs: 'Modifier les documents',
    adminPermRemoveAccount: 'Supprimer le compte',
    adminPermDeleteMessages: 'Supprimer les messages',
    adminPermManageUsers: 'Gérer les utilisateurs',
    adminPermTimeout: 'Mettre en sourdine',
    adminRoleAdmin: 'Administrateur',
    adminRoleDeleted: 'Supprimé',
    adminRoleOnList: 'Sur la liste des administrateurs',
    adminRoleMember: 'Membre',
    adminRemoveFromList: 'Retirer de la liste',
    adminAddToList: 'Ajouter à la liste',
    adminRestore: 'Restaurer',
    adminDeletePermanently: 'Supprimer définitivement',
    adminRemoveAccount: 'Supprimer le compte',
    adminBlacklist: 'Liste noire',
    adminUnblacklist: 'Retirer de la liste noire',
    adminDeleteAccountTitle: 'Supprimer le compte définitivement',
    adminDeleteAccountDesc: 'Cela supprimera l\'utilisateur de la liste, le retirera des listes de chat privé et effacera toutes ses données. Cette action est irréversible.',
    adminDeleteGroupMessages: 'Supprimer aussi les messages du chat de groupe',
    adminDeleteAdmin: 'Supprimer (admin)',
    adminRemoveAccountConfirm: 'Supprimer ce compte ? L\'utilisateur ne pourra plus se connecter. Les messages restent. Vous pourrez restaurer plus tard.',
    replyToMessage: 'Répondre au message',
    recall: 'Récupérer',
    edit: 'Modifier',
    solve: 'Marquer comme résolu',
    getFileId: 'Obtenir l\'ID du fichier',
    copy: 'Copier',
    reply: 'Répondre',
    mentionDeletedUsers: 'Note : Vous mentionnez des utilisateur(s) dont les comptes ont été supprimés : ',
    adminNoRecalledMessages: 'Aucun message récupéré.',
    adminFailedToLoad: 'Échec du chargement.',
    adminSent: 'Envoyé.',
    adminBroadcastSent: 'Diffusion envoyée.',
    adminNoActiveTimeouts: 'Aucune mise en sourdine active.',
    adminTimeoutUntil: 'jusqu\'à ',
    adminTimeoutForever: 'pour toujours',
    adminTimeoutLocked: '(verrouillé)',
    adminRelease: 'Libérer',
  },
  'de': {
    general: 'Allgemein',
    profile: 'Profil',
    account: 'Konto',
    settings: 'Einstellungen',
    theme: 'Design',
    systemLanguage: 'Systemsprache',
    chooseTheme: 'Wählen Sie das visuelle Design der App.',
    chooseLanguage: 'Wählen Sie die Anzeigesprache der App.',
    language: 'Sprache',
    password: 'Passwort',
    changePassword: 'Passwort ändern',
    changePasswordDesc: 'Ändern Sie Ihr Passwort. Ihr aktuelles Passwort wird benötigt.',
    signOut: 'Abmelden',
    signOutDesc: 'Von diesem Gerät abmelden.',
    home: 'Startseite',
    chat: 'Chat',
    inbox: 'Posteingang',
    admin: 'Verwaltung',
    expand: 'Erweitern',
    collapse: 'Einklappen',
    dropImage: 'Bild hier ablegen oder unten auswählen',
    chooseImage: 'Bild auswählen',
    displayName: 'Anzeigename',
    username: 'Benutzername',
    description: 'Beschreibung',
    descriptionPlaceholder: 'Eine kurze Biografie oder Beschreibung',
    website: 'Website',
    save: 'Speichern',
    avatar: 'Avatar',
    loading: 'Laden…',
    selectPanel: 'Wählen Sie einen Bereich.',
    selectConversation: 'Wählen Sie eine Konversation.',
    noMailYet: 'Noch keine Nachrichten.',
    accept: 'Akzeptieren',
    reject: 'Ablehnen',
    'delete': 'Löschen',
    deleteMailConfirm: 'Diese Nachricht löschen?',
    recording: 'Aufnahme',
    cancel: 'Abbrechen',
    send: 'Senden',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    confirmNewPassword: 'Neues Passwort bestätigen',
    atLeast6: 'Mindestens 6 Zeichen',
    confirmNewPasswordPlaceholder: 'Neues Passwort bestätigen',
    passwordChanged: 'Passwort geändert.',
    fillCurrentNew: 'Bitte geben Sie das aktuelle und das neue Passwort ein.',
    newPasswordMin: 'Das neue Passwort muss mindestens 6 Zeichen haben.',
    newPasswordMismatch: 'Neues Passwort und Bestätigung stimmen nicht überein.',
    failedChangePassword: 'Passwortänderung fehlgeschlagen.',
    usernameOrEmail: 'Benutzername oder E-Mail',
    confirmPassword: 'Passwort bestätigen',
    email: 'E-Mail',
    signUp: 'Registrieren',
    login: 'Anmelden',
    alreadyHaveAccount: 'Bereits ein Konto? ',
    noAccount: 'Noch kein Konto? ',
    logIn: 'Anmelden',
    passwordRequired: 'Passwort ist erforderlich',
    passwordsDoNotMatch: 'Passwörter stimmen nicht überein',
    freeChat: 'Freier Chat',
    support: 'Support',
    problemSolving: 'Problemlösung',
    rules: 'Regeln',
    announcements: 'Ankündigungen',
    action: 'Aktion',
    users: 'Benutzer',
    recalled: 'Widerrufen',
    timeout: 'Auszeit',
    block: 'Blockieren',
    unblock: 'Entsperren',
    blocked: 'Blockiert',
    sendFriendRequest: 'Freundschaftsanfrage senden',
    requestSent: 'Anfrage gesendet',
    sendMessage: 'Nachricht senden',
    notifications: 'Benachrichtigungen',
    notificationsDesc: 'Desktop-Benachrichtigungen für Nachrichten und E-Mail.',
    notifyMails: 'E-Mail (Posteingang)',
    notifyDm: 'Private Nachrichten',
    notifyGroup: 'Gruppennachrichten',
    doNotDisturb: 'Nicht stören',
    dndSet: 'Festlegen',
    dndCancel: 'Abbrechen',
    dndDays: 'Tage',
    dndHours: 'Stunden',
    dndMinutes: 'Minuten',
    dndSeconds: 'Sekunden',
    dndEndNow: 'Nicht stören jetzt beenden',
    dndAtNight: 'Nachts nicht stören',
    dndUseLocation: 'Meinen Standort verwenden',
    dndEnterCity: 'Stadt eingeben',
    dndCityHint: 'Geben Sie Ihre Stadt ein, um ihre Ortszeit für die Nachtstunden zu verwenden.',
    dndCityPlaceholder: 'z.B. Berlin, München',
    scrollToBottom: 'Nach unten scrollen',
    notifModalTitle: 'Desktop-Benachrichtigungen',
    notifModalDesc: 'Möchten Sie Desktop-Benachrichtigungen dieser Chat-App auf diesem Gerät erhalten? Sie können dies später unter Einstellungen → Benachrichtigungen ändern.',
    notifModalAllow: 'Benachrichtigungen aktivieren',
    notifModalDecline: 'Nicht jetzt',
    adminSendToInbox: 'An Posteingang senden',
    adminSendToInboxDesc: 'Eine Nachricht an den Posteingang eines bestimmten Benutzers senden.',
    adminBroadcast: 'An alle senden',
    adminBroadcastDesc: 'Eine Nachricht an den Posteingang aller Benutzer senden.',
    adminTimeoutUser: 'Benutzer stummschalten',
    adminTimeoutDurationDesc: 'Einen Benutzer für eine bestimmte Zeit am Senden von Nachrichten im JimmyQrg-Gruppenchat hindern.',
    adminTimeoutUserDesc: 'Einen Benutzer am Senden von Nachrichten im JimmyQrg-Gruppenchat hindern.',
    adminSelectUser: 'Benutzer auswählen',
    adminTitle: 'Titel',
    adminBody: 'Inhalt',
    adminMessageBody: 'Nachrichtentext',
    adminDuration: 'Dauer',
    adminDurationPlaceholder: 'z.B. 5 Minuten, 1 Stunde, dauerhaft',
    adminOnlyICanRelease: 'Nur ich kann freigeben',
    adminNoPermissions: 'Sie haben keine Aktionsberechtigungen. Bitten Sie einen Administrator um E-Mail senden, Senden oder Stummschalten.',
    adminRecalledMessages: 'Widerrufene Nachrichten',
    adminRecalledDesc: 'Nachrichten, die von Benutzern im Gruppenchat widerrufen wurden.',
    adminUsersSection: 'Benutzer',
    adminUsersDesc: 'Fügen Sie hier Benutzer zur Admin-Liste hinzu. Nach dem Hinzufügen legen Sie fest, was sie dürfen (z.B. E-Mail senden, senden, Dokumente bearbeiten).',
    adminPermSendMail: 'E-Mail senden',
    adminPermBroadcast: 'Senden',
    adminPermEditDocs: 'Dokumente bearbeiten',
    adminPermRemoveAccount: 'Konto entfernen',
    adminPermDeleteMessages: 'Nachrichten löschen',
    adminPermManageUsers: 'Benutzer verwalten',
    adminPermTimeout: 'Stummschalten',
    adminRoleAdmin: 'Administrator',
    adminRoleDeleted: 'Gelöscht',
    adminRoleOnList: 'In Admin-Liste',
    adminRoleMember: 'Mitglied',
    adminRemoveFromList: 'Von Liste entfernen',
    adminAddToList: 'Zur Liste hinzufügen',
    adminRestore: 'Wiederherstellen',
    adminDeletePermanently: 'Dauerhaft löschen',
    adminRemoveAccount: 'Konto entfernen',
    adminBlacklist: 'Schwarze Liste',
    adminUnblacklist: 'Von schwarzer Liste entfernen',
    adminDeleteAccountTitle: 'Konto dauerhaft löschen',
    adminDeleteAccountDesc: 'Dies entfernt den Benutzer aus der Liste, aus privaten Chat-Listen und löscht alle seine Daten. Dies kann nicht rückgängig gemacht werden.',
    adminDeleteGroupMessages: 'Auch Nachrichten im Gruppenchat löschen',
    adminDeleteAdmin: 'Löschen (Admin)',
    adminRemoveAccountConfirm: 'Dieses Konto entfernen? Der Benutzer kann sich nicht mehr anmelden. Nachrichten bleiben. Sie können später wiederherstellen.',
    replyToMessage: 'Auf Nachricht antworten',
    recall: 'Widerrufen',
    edit: 'Bearbeiten',
    solve: 'Als gelöst markieren',
    getFileId: 'Datei-ID abrufen',
    copy: 'Kopieren',
    reply: 'Antworten',
    mentionDeletedUsers: 'Hinweis: Sie erwähnen Benutzer, deren Konten gelöscht wurden: ',
    adminNoRecalledMessages: 'Keine widerrufenen Nachrichten.',
    adminFailedToLoad: 'Laden fehlgeschlagen.',
    adminSent: 'Gesendet.',
    adminBroadcastSent: 'Rundsendung gesendet.',
    adminNoActiveTimeouts: 'Keine aktiven Stummschaltungen.',
    adminTimeoutUntil: 'bis ',
    adminTimeoutForever: 'dauerhaft',
    adminTimeoutLocked: '(gesperrt)',
    adminRelease: 'Freigeben',
  },
};

const GROUP_ID = 'JimmyQrg';

/** Current user avatar URL with cache-busting so updates show after profile save. */
function getCurrentUserAvatarUrl() {
  const u = state.user;
  if (!u) return getDefaultAvatarUrl(null);
  const base = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : getDefaultAvatarUrl(u.id);
  if (!base || !base.startsWith('/')) return base;
  return base + '?v=' + (u._avatarVersion || 0);
}

// URL panel param <-> internal panel
const PANEL_TO_URL = { free_chat: 'chat', support: 'support', problem_solving: 'problem', rules: 'rules', announcements: 'announcements' };
const URL_TO_PANEL = { chat: 'free_chat', support: 'support', problem: 'problem_solving', rules: 'rules', announcements: 'announcements' };

function roomKey(roomType, roomId) {
  return `${roomType}:${roomId}`;
}

function currentRoomKey() {
  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  return roomId ? roomKey(roomType, roomId) : null;
}

function getNewCount(roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list || !list.length) return 0;
  const seen = state.lastSeenByRoom[key] || 0;
  return list.filter(m => (m.created_at || 0) > seen).length;
}

/** Group chat: show red dot only (no amount). */
function hasNewGroupMessages() {
  const panels = state.group?.panels || [];
  return panels.some(p => (p === 'free_chat' || p === 'support') && getNewCount('group', p) > 0);
}

/** Private chat: show total new count on Chat icon and per-user in list. */
function getTotalNewDmCount() {
  let total = 0;
  for (const key of Object.keys(state.messages || {})) {
    if (key.startsWith('dm:')) total += getNewCount('dm', key.slice(4));
  }
  return total;
}

function getUnreadInboxCount() {
  return (state.inbox || []).filter(i => !i.read_at).length;
}

function getPath() {
  return window.location.pathname.replace(/\/$/, '') || '/';
}

function interceptLinks(container) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else navigateTo(`/chat/${encodeURIComponent(id)}?view=profile`);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        e.stopPropagation();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else navigateTo(`/chat/${encodeURIComponent(id)}?view=profile`);
      }
      return;
    }
    const linkifyA = e.target.closest('a.linkify-link');
    if (linkifyA) {
      e.preventDefault();
      e.stopPropagation();
      const href = linkifyA.getAttribute('href');
      const comefrom = getPath();
      const u = `/redirect.html?url=${encodeURIComponent(href || '')}&comefrom=${encodeURIComponent(comefrom)}`;
      window.open(u, '_blank', 'noopener');
      return;
    }
    const a = e.target.closest('a[href^="/"]');
    if (!a || a.hasAttribute('target') || a.getAttribute('href').startsWith('/api')) return;
    e.preventDefault();
    navigateTo(a.getAttribute('href'));
  });
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const messageAvatarWrap = e.target.closest('.message-avatar-wrap');
    if (messageAvatarWrap) {
      const id = messageAvatarWrap.dataset.senderId;
      if (id) {
        e.preventDefault();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else navigateTo(`/chat/${encodeURIComponent(id)}?view=profile`);
      }
      return;
    }
    const panelAvatarWrap = e.target.closest('.panel-user-avatar-wrap');
    if (panelAvatarWrap) {
      const id = panelAvatarWrap.dataset.userId;
      if (id) {
        e.preventDefault();
        if (id === state.user?.id) navigateTo('/settings?tab=profile');
        else navigateTo(`/chat/${encodeURIComponent(id)}?view=profile`);
      }
    }
  });
}

const LINK_PREVIEW_DELAY_MS = 500;
let linkPreviewTimer = null;
let linkPreviewEl = null;
let linkPreviewAbort = null;

function bindLinkPreview(container) {
  if (!container) return;
  container.addEventListener('mouseenter', (e) => {
    const a = e.target.closest('a[href^="http"]');
    if (!a || a.closest('.link-preview-popover')) return;
    const href = a.getAttribute('href')?.trim();
    if (!href) return;
    linkPreviewTimer = setTimeout(async () => {
      linkPreviewTimer = null;
      linkPreviewAbort = new AbortController();
      try {
        const data = await apiGet(`/api/link-preview?url=${encodeURIComponent(href)}`);
        if (!data.title && !data.description && !data.image) return;
        hideLinkPreview();
        const descLimit = 320;
        const desc = data.description ? escapeHtml(data.description.slice(0, descLimit)) + (data.description.length > descLimit ? '…' : '') : '';
        linkPreviewEl = document.createElement('div');
        linkPreviewEl.className = 'link-preview-popover';
        linkPreviewEl.innerHTML = `
          ${data.image ? `<img src="${escapeHtml(data.image)}" alt="" class="link-preview-img" />` : ''}
          <div class="link-preview-body">
            ${data.title ? `<div class="link-preview-title">${escapeHtml(data.title)}</div>` : ''}
            ${desc ? `<div class="link-preview-desc">${desc}</div>` : ''}
          </div>
        `;
        document.body.appendChild(linkPreviewEl);
        const rect = a.getBoundingClientRect();
        linkPreviewEl.style.left = `${rect.left}px`;
        linkPreviewEl.style.top = `${rect.top - 8}px`;
        linkPreviewEl.style.transform = 'translateY(-100%)';
        linkPreviewEl.addEventListener('mouseleave', () => hideLinkPreview());
      } catch (_) {}
    }, LINK_PREVIEW_DELAY_MS);
  }, true);
  container.addEventListener('mouseleave', (e) => {
    const a = e.target.closest('a[href^="http"]');
    if (a && !e.relatedTarget?.closest?.('.link-preview-popover')) {
      if (linkPreviewTimer) {
        clearTimeout(linkPreviewTimer);
        linkPreviewTimer = null;
      }
      hideLinkPreview();
    }
  }, true);
}

function hideLinkPreview() {
  if (linkPreviewEl) {
    linkPreviewEl.remove();
    linkPreviewEl = null;
  }
}

function parseRoute() {
  const pathname = window.location.pathname;
  const params = new URLSearchParams(window.location.search || '');
  const redirect = params.get('redirect') || null;

  // Normalize group chat: only /chat/group/ is valid (trailing slash required, no /chat/group/index etc.)
  if (pathname === '/chat/group' || (pathname.startsWith('/chat/group/') && pathname !== '/chat/group/')) {
    const search = window.location.search || '';
    if (window.location.pathname !== '/chat/group/' || window.location.search !== search) {
      window.history.replaceState({}, '', '/chat/group/' + search);
    }
  }

  const path = getPath();
  if (path === '/login') return { page: 'login', redirect };
  if (path === '/signup') return { page: 'signup', redirect };
  if (path === '/settings') return { page: 'settings', tab: params.get('tab') || 'profile' };
  if (path === '/inbox') return { page: 'inbox' };
  if (path === '/manage' || path === '/manage/') return { page: 'admin', adminTab: params.get('tab') || 'action' };
  if (path === '/chat') return { page: 'chat', section: 'dms' }; // DM user list, no conversation selected
  const chatMatch = path.match(/^\/chat\/([^/]+)$/);
  if (chatMatch) {
    const id = chatMatch[1];
    if (id.toLowerCase() === 'group') {
      const panelParam = params.get('panel') || 'chat';
      const panel = URL_TO_PANEL[panelParam] || 'free_chat';
      return { page: 'chat', group: true, panel };
    }
    return { page: 'chat', dmUserId: id, view: params.get('view') || null };
  }
  return { page: 'chat', group: true, panel: 'free_chat' };
}

/** Primary nav for app shell: home (group), chat (DMs), inbox, admin, settings */
function getPrimaryNav(route) {
  if (route.page === 'admin') return 'admin';
  if (route.page === 'settings') return 'settings';
  if (route.page === 'inbox') return 'inbox';
  if (route.page === 'chat') return route.group ? 'home' : 'chat';
  return 'home';
}

function getPage() {
  const route = parseRoute();
  return route.page;
}

/** Build auth path with optional redirect param. Use when navigating to login/signup. */
function authPath(page, redirectPath) {
  const base = page === 'signup' ? '/signup' : '/login';
  if (!redirectPath) return base;
  const enc = encodeURIComponent(redirectPath.startsWith('/') ? redirectPath : '/' + redirectPath);
  return `${base}?redirect=${enc}`;
}

/** Get redirect target from current URL, or default path. */
function getRedirectOrDefault(defaultPath = '/chat/group/') {
  const params = new URLSearchParams(window.location.search || '');
  const r = params.get('redirect');
  return (r && r.startsWith('/')) ? r : defaultPath;
}

/** True if we consider this a mobile context (Enter should add newline instead of send). */
function isMobile() {
  return typeof window !== 'undefined' && (('ontouchstart' in window) || (window.matchMedia && window.matchMedia('(max-width: 768px)').matches));
}

function navigateTo(path) {
  const full = path.startsWith('http') ? path : (path.startsWith('/') ? path : '/' + path);
  if (full.startsWith('http') && new URL(full).origin !== window.location.origin) {
    window.location.href = full;
    return;
  }
  const pathname = full.startsWith('http') ? new URL(full).pathname : full.split('?')[0];
  const search = full.includes('?') ? full.slice(full.indexOf('?')) : '';
  if (window.location.pathname !== pathname || window.location.search !== search) {
    window.history.pushState({}, '', pathname + search);
  }
  applyRoute(parseRoute());
}

export function getState() {
  return state;
}

export function setState(updates) {
  Object.assign(state, updates);
  render();
}

const LOAD_ME_TIMEOUT_MS = 12_000;

/** Load current user from session. 401 here is expected when not logged in (e.g. on login/signup page). */
export async function loadMe() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LOAD_ME_TIMEOUT_MS);
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include', signal: controller.signal });
    clearTimeout(timeoutId);
    if (res.status === 401) {
      state.user = null;
      return null;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    state.user = data.user;
    return data.user;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      console.warn('Auth check timed out; showing login.');
    }
    state.user = null;
    return null;
  }
}

/** Load public config (e.g. reCAPTCHA site key). Cached in state. */
export async function loadConfig() {
  if (state._configLoaded) return state.recaptchaSiteKey != null ? { recaptchaSiteKey: state.recaptchaSiteKey } : null;
  try {
    const data = await apiGet('/api/config');
    state.recaptchaSiteKey = data.recaptchaSiteKey || '';
    state._configLoaded = true;
    return data;
  } catch {
    state._configLoaded = true;
    state.recaptchaSiteKey = '';
    return { recaptchaSiteKey: '' };
  }
}

export async function loadUsers() {
  const { users } = await apiGet('/api/users');
  state.users = users;
  return users;
}

export async function loadGroup() {
  const g = await apiGet('/api/group');
  state.group = g;
  return g;
}

export async function loadMessages(roomType, roomId) {
  const key = roomKey(roomType, roomId);
  state._loadingMessages = state._loadingMessages || {};
  state._loadingMessages[key] = true;
  setState({});
  try {
  const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
  const { messages } = await apiGet(path);
  state.messages[key] = messages || [];
    state.blacklisted = false;
    const list = state.messages[key];
    if (currentRoomKey() === key && list.length) {
      const maxAt = Math.max(...list.map(m => m.created_at || 0));
      state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, maxAt);
    }
    return list;
  } catch (err) {
    if (roomType === 'group' && err?.status === 403 && /blacklist/i.test(err?.message || '')) {
      state.blacklisted = true;
      state.messages[key] = [];
    }
    throw err;
  } finally {
    state._loadingMessages[key] = false;
  }
}

export async function loadDoc(docKey) {
  return apiGet(`/api/docs/${docKey}`);
}

export async function saveDoc(docKey, content, supportMessageId) {
  return apiPut(`/api/docs/${docKey}`, { content, support_message_id: supportMessageId });
}

export async function loadInbox() {
  const { items } = await apiGet('/api/inbox');
  state.inbox = items || [];
  return state.inbox;
}

/** Load conversation list so DM list order (last chat time > new count > alpha) and per-user badges work. */
export async function loadConversations() {
  const { conversations } = await apiGet('/api/conversations').catch(() => ({ conversations: [] }));
  state.lastMessageAtByUserId = {};
  (conversations || []).forEach((c) => {
    state.convByUserId[c.other_user_id] = c.conversation_id;
    state.convIdToUserId[c.conversation_id] = c.other_user_id;
    if (c.last_message_at != null) state.lastMessageAtByUserId[c.other_user_id] = c.last_message_at;
  });
  return conversations || [];
}

export async function loadFriends() {
  try {
    const { friend_ids } = await apiGet('/api/friends');
    state.friend_ids = friend_ids || [];
    return state.friend_ids;
  } catch {
    state.friend_ids = [];
    return [];
  }
}

export async function loadBlocks() {
  try {
    const { blocked_ids } = await apiGet('/api/blocks');
    state.blocked_ids = blocked_ids || [];
    return state.blocked_ids;
  } catch {
    state.blocked_ids = [];
    return [];
  }
}

export async function loadNotificationPrefs() {
  try {
    const prefs = await apiGet('/api/notifications/prefs');
    state.notificationPrefs = prefs;
    return prefs;
  } catch {
    state.notificationPrefs = null;
    return null;
  }
}

function showNotificationPermissionModal() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const asked = localStorage.getItem('notification_asked');
  if (asked === '1') return;
  if (state.notificationPrefs?.enabled) return;
  const existing = document.getElementById('notif-permission-modal');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = 'notif-permission-modal';
  overlay.className = 'notif-permission-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'notif-permission-title');
  overlay.innerHTML = `
    <div class="notif-permission-modal">
      <h2 id="notif-permission-title" class="notif-permission-title">${t('notifModalTitle')}</h2>
      <p class="notif-permission-desc">${t('notifModalDesc')}</p>
      <div class="notif-permission-actions">
        <button type="button" class="btn-primary notif-permission-allow" id="notif-permission-allow">${t('notifModalAllow')}</button>
        <button type="button" class="btn-secondary notif-permission-decline" id="notif-permission-decline">${t('notifModalDecline')}</button>
      </div>
    </div>
  `;
  overlay.querySelector('#notif-permission-allow').addEventListener('click', () => {
    localStorage.setItem('notification_asked', '1');
    overlay.remove();
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') {
        apiPatch('/api/notifications/prefs', { enabled: true }).then(() => {
          state.notificationPrefs = { ...(state.notificationPrefs || {}), enabled: true };
        }).catch(() => {});
      }
    });
  });
  overlay.querySelector('#notif-permission-decline').addEventListener('click', () => {
    localStorage.setItem('notification_asked', '1');
    overlay.remove();
  });
  document.body.appendChild(overlay);
}

function maybeAskNotificationPermission() {
  showNotificationPermissionModal();
}

function shouldShowNotifPermissionModal() {
  return ('Notification' in window) && Notification.permission === 'default' &&
    localStorage.getItem('notification_asked') !== '1' && !state.notificationPrefs?.enabled;
}

function ensureNotificationPermissionModalVisible() {
  if (!shouldShowNotifPermissionModal()) return;
  const existing = document.getElementById('notif-permission-modal');
  if (existing) {
    const style = getComputedStyle(existing);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.01) {
      existing.remove();
      showNotificationPermissionModal();
    }
    return;
  }
  showNotificationPermissionModal();
}

const DND_TZ_KEY = 'dnd_timezone';

function getDndTimezone() {
  try {
    const tz = localStorage.getItem(DND_TZ_KEY);
    return tz && tz.length < 64 ? tz : null;
  } catch (_) { return null; }
}

function setDndTimezone(tz) {
  try {
    if (tz) localStorage.setItem(DND_TZ_KEY, tz);
    else localStorage.removeItem(DND_TZ_KEY);
  } catch (_) {}
}

function isNightTime() {
  try {
    const tz = getDndTimezone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }), 10);
    return hour >= 22 || hour < 7;
  } catch (_) {
    const hour = new Date().getHours();
    return hour >= 22 || hour < 7;
  }
}

/** Try geolocation -> /api/timezone, save to localStorage. Returns Promise<boolean>. */
async function resolveDndTimezoneFromLocation() {
  if (!navigator.geolocation) return false;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { lat, lng } = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          const data = await apiGet(`/api/timezone?lat=${lat}&lng=${lng}`);
          if (data?.timezone) {
            setDndTimezone(data.timezone);
            resolve(true);
          } else resolve(false);
        } catch (_) { resolve(false); }
      },
      () => resolve(false),
      { timeout: 10000, maximumAge: 86400000 }
    );
  });
}

/** Geocode city -> timezone, save. Returns Promise<boolean>. */
async function resolveDndTimezoneFromCity(city) {
  const q = (city || '').trim().slice(0, 100);
  if (!q) return false;
  try {
    const geo = await apiGet(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (geo?.lat == null || geo?.lon == null) return false;
    const tzData = await apiGet(`/api/timezone?lat=${geo.lat}&lng=${geo.lon}`);
    if (tzData?.timezone) {
      setDndTimezone(tzData.timezone);
      return true;
    }
  } catch (_) {}
  return false;
}

function shouldShowNotification(trigger, fromUserId) {
  const prefs = state.notificationPrefs;
  if (!prefs?.enabled) return false;
  if (document.hasFocus?.() && document.visibilityState === 'visible') return false;
  const now = Date.now();
  if (prefs.dnd_until && now < prefs.dnd_until) return false;
  if (prefs.dnd_at_night && isNightTime()) return false;
  if (trigger === 'mail' && !prefs.notify_mails) return false;
  if (trigger === 'dm' && !prefs.notify_dm) return false;
  if (trigger === 'group' && !prefs.notify_group) return false;
  if (trigger === 'dm' && fromUserId) {
    if (prefs.dm_allow_list?.length && !prefs.dm_allow_list.includes(fromUserId)) return false;
    if (prefs.dm_block_list?.length && prefs.dm_block_list.includes(fromUserId)) return false;
  }
  return true;
}

function showDesktopNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title || 'JimmyQrg Chat', { body: body || '', icon: '/assets/favicon.ico' });
  } catch (_) {}
}

function isBlocked(userId) {
  return state.blocked_ids && state.blocked_ids.includes(userId);
}

function isUserDeleted(userId) {
  const u = (state.users || []).find(x => x.id === userId);
  return u && u.deleted_at != null;
}

/** Returns usernames of deleted users mentioned in content (excluding @All). */
function getMentionedDeletedUsers(content) {
  if (!content || typeof content !== 'string') return [];
  const mentioned = [...(content.matchAll(/\@([a-z0-9]+)/gi) || [])].map(m => m[1].toLowerCase());
  const deleted = [];
  for (const u of (state.users || [])) {
    if (u.deleted_at != null && mentioned.includes((u.username || '').toLowerCase())) deleted.push(u.display_name || u.username || u.id);
  }
  return deleted;
}

function isFriend(userId) {
  return state.friend_ids && state.friend_ids.includes(userId);
}

export function addMessageLocal(msg) {
  if (isBlocked(msg.sender_id)) return;
  const key = roomKey(msg.room_type, msg.room_id);
  if (!state.messages[key]) state.messages[key] = [];
  if (state.messages[key].some(m => m.id === msg.id)) return;
  state.messages[key].push(msg);
  if (currentRoomKey() === key) {
    state.lastSeenByRoom[key] = Math.max(state.lastSeenByRoom[key] || 0, msg.created_at || 0);
  }
  render();
}

export function updateMessageLocal(id, roomType, roomId, patch) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list[i] = { ...list[i], ...patch };
  render();
}

export function removeMessageContent(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { content: null, recalled_at: Date.now(), msg_type: 'recalled' });
}

export function deleteMessageLocal(id, roomType, roomId) {
  updateMessageLocal(id, roomType, roomId, { deleted_by_admin: 1, content: null, msg_type: 'deleted' });
}

/** Remove a message from the list entirely (admin delete – no trace). */
export function removeMessageLocal(id, roomType, roomId) {
  const key = roomKey(roomType, roomId);
  const list = state.messages[key];
  if (!list) return;
  const i = list.findIndex(m => m.id === id);
  if (i === -1) return;
  list.splice(i, 1);
  render();
}

/** Find a message by id in state.messages (group messages live under group:free_chat / group:support, not group:JimmyQrg). */
function findMessageInState(msgId) {
  if (!msgId) return null;
  for (const key of Object.keys(state.messages || {})) {
    const m = state.messages[key].find(x => x.id === msgId);
    if (m) return m;
  }
  return null;
}

let _connectSocketScheduled = null;
function connectSocket() {
  if (_connectSocketScheduled) return;
  _connectSocketScheduled = true;
  const io = window.io;
  if (!io) {
    _connectSocketScheduled = false;
    return;
  }
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  const s = io({
    withCredentials: true,
    transports: ['polling', 'websocket'],
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    timeout: 20000,
  });
  s.on('connect', () => {
    _connectSocketScheduled = false;
    if (state.dmUserId && state.convId) s.emit('dm:join', state.convId, () => {});
  });
  s.on('connect_error', (err) => {
    _connectSocketScheduled = false;
    if (err?.message === 'Not authenticated' || err?.message?.includes('auth')) {
      state.user = null;
      state.socket = null;
      state.authError = 'Session expired. Please log in again.';
      navigateTo('/login');
    }
  });
  s.on('disconnect', () => {
    _connectSocketScheduled = false;
  });
  s.on('message', (msg) => {
    addMessageLocal(msg);
    const trigger = msg.room_type === 'dm' ? 'dm' : 'group';
    if (shouldShowNotification(trigger, msg.sender_id)) {
      const from = msg.display_name || msg.username || 'Someone';
      const preview = (msg.content || '').slice(0, 80);
      showDesktopNotification(`${from}: ${trigger === 'dm' ? 'Private message' : 'Group'}`, preview || '(attachment)');
    }
  });
  s.on('message:recalled', ({ id }) => {
    const m = findMessageInState(id);
    if (m) removeMessageContent(id, m.room_type, m.room_id);
  });
  s.on('message:edited', ({ id, content, edit_history, updated_at }) => {
    const m = findMessageInState(id);
    if (m) updateMessageLocal(id, m.room_type, m.room_id, { content, edit_history, updated_at });
  });
  s.on('message:liked', ({ id, likes }) => {
    const m = findMessageInState(id);
    if (m) {
      updateMessageLocal(id, m.room_type, m.room_id, { likes });
      if (m.sender_id === state.user?.id && shouldShowNotification('group', null)) {
        showDesktopNotification('JimmyQrg Chat', 'Someone liked your message');
      }
    }
  });
  s.on('message:deleted', ({ id }) => {
    const m = findMessageInState(id);
    if (m) removeMessageLocal(id, m.room_type, m.room_id);
  });
  s.on('account_removed', () => {
    showToast('Your account has been removed.');
    window.location.reload();
  });
  s.on('inbox:item', (item) => {
    if (shouldShowNotification('mail', null)) {
      showDesktopNotification(item?.title || 'New mail', item?.body || '');
    }
    loadInbox().then(render);
  });
  state.socket = s;
}

function render() {
  const app = document.getElementById('app');
  if (!app) return;
  app.classList.remove('app-loading');
  const route = parseRoute();

  if (!state.user) {
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.add('auth-page');
    const isSignup = route.page === 'signup';
    const redirect = route.redirect || null;
    const authError = state.authError || '';
    state.authError = null;
    const isAuthSwitch = state.authPrevSignup != null && state.authPrevSignup !== isSignup && app.querySelector('.auth-screen');
    if (isAuthSwitch) {
      authTransition(app, state.authPrevSignup, isSignup, authError, redirect);
    } else {
      app.innerHTML = renderAuth(isSignup, authError, redirect);
    bindAuth(isSignup);
    }
    state.authPrevSignup = isSignup;
    return;
  }

  applyTheme(state.theme);
  document.body.classList.remove('auth-page');
  app.innerHTML = renderMain();
  bindMain();
  if (route.page === 'settings') bindSettings();
}

function renderAuth(isSignup = false, initialError = '', redirect = null) {
  const switchHref = authPath(isSignup ? 'login' : 'signup', redirect);
  return `
    <div class="auth-screen auth-ani-1">
      <div class="auth-box auth-ani-2">
        <h1 class="auth-ani-3">JimmyQrg Chat</h1>
        <form id="auth-form" class="auth-ani-7" novalidate>
          <div id="auth-error" class="error auth-ani-8">${initialError ? escapeHtml(initialError) : ''}</div>
          <div id="auth-fields-login" class="auth-ani-9" style="display:${isSignup ? 'none' : 'block'}">
            <label class="auth-ani-10">${t('usernameOrEmail')}</label>
            <input class="auth-ani-11" name="login_identifier" type="text" autocomplete="username" placeholder="${t('usernameOrEmail')}" />
            <label class="auth-ani-12">${t('password')}</label>
            <input class="auth-ani-13" name="login_password" type="password" autocomplete="current-password" />
        </div>
          <div id="auth-fields-register" class="auth-ani-14" style="display:${isSignup ? 'block' : 'none'}">
            <label class="auth-ani-15">${t('displayName')}</label>
            <input class="auth-ani-16" name="display_name" type="text" autocomplete="name" placeholder="${t('displayName')}" />
            <label class="auth-ani-17">Username (lowercase letters and numbers only)</label>
            <input class="auth-ani-18" name="reg_username" type="text" autocomplete="username" placeholder="Username" />
            <label class="auth-ani-19">${t('email')}</label>
            <input class="auth-ani-20" name="email" type="email" autocomplete="email" placeholder="${t('email')}" />
            <label class="auth-ani-21">${t('password')}</label>
            <input class="auth-ani-22" name="reg_password" type="password" autocomplete="new-password" placeholder="${t('password')}" />
            <label class="auth-ani-23">${t('confirmPassword')}</label>
            <input class="auth-ani-24" name="confirm_password" type="password" autocomplete="new-password" placeholder="${t('confirmPassword')}" />
            <div id="auth-recaptcha-wrap" class="auth-recaptcha-wrap" aria-live="polite"></div>
          </div>
          <button type="submit" id="auth-submit" class="auth-ani-25">${isSignup ? t('signUp') : t('login')}</button>
          <p class="auth-switch auth-ani-26">
            ${isSignup ? t('alreadyHaveAccount') : t('noAccount')}
            <a href="${switchHref}" class="auth-switch-link">${isSignup ? t('logIn') : t('signUp')}</a>
          </p>
        </form>
      </div>
    </div>
  `;
}

function authTransition(container, fromSignup, toSignup, authError, redirect) {
  const box = container.querySelector('.auth-box');
  const form = container.querySelector('#auth-form');
  if (!box || !form) return;
  const formContent = form;
  const beforeHeight = box.offsetHeight;

  formContent.classList.add('auth-content-vanish');
  formContent.offsetHeight;

  formContent.addEventListener('transitionend', function onVanish(e) {
    if (e.target !== formContent || e.propertyName !== 'opacity') return;
    formContent.removeEventListener('transitionend', onVanish);

    const errEl = form.querySelector('#auth-error');
    const fieldsLogin = form.querySelector('#auth-fields-login');
    const fieldsRegister = form.querySelector('#auth-fields-register');
    const submitBtn = form.querySelector('#auth-submit');
    const switchP = form.querySelector('.auth-switch');

    if (errEl) errEl.textContent = authError || '';
    if (fieldsLogin) fieldsLogin.style.display = toSignup ? 'none' : 'block';
    if (fieldsRegister) fieldsRegister.style.display = toSignup ? 'block' : 'none';
    if (submitBtn) submitBtn.textContent = toSignup ? 'Sign up' : 'Login';
    if (switchP) {
      switchP.innerHTML = toSignup ? 'Already have an account? ' : "Don't have an account? ";
      const link = document.createElement('a');
      link.href = authPath(toSignup ? 'login' : 'signup', redirect);
      link.className = 'auth-switch-link';
      link.textContent = toSignup ? 'Log in' : 'Sign up';
      switchP.appendChild(link);
    }

    const afterHeight = box.offsetHeight;
    if (beforeHeight !== afterHeight) {
      box.style.height = beforeHeight + 'px';
      box.style.overflow = 'hidden';
      box.style.transition = 'height 0.25s ease';
      box.offsetHeight;
      box.style.height = afterHeight + 'px';
      box.addEventListener('transitionend', function onResize(e) {
        if (e.target !== box || e.propertyName !== 'height') return;
        box.removeEventListener('transitionend', onResize);
        box.style.height = '';
        box.style.overflow = '';
        box.style.transition = '';
        formContent.classList.remove('auth-content-vanish');
        formContent.classList.add('auth-content-appear');
        formContent.offsetHeight;
        formContent.addEventListener('transitionend', function onAppear(ev) {
          if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
          formContent.removeEventListener('transitionend', onAppear);
          formContent.classList.remove('auth-content-appear');
        });
      });
    } else {
      formContent.classList.remove('auth-content-vanish');
      formContent.classList.add('auth-content-appear');
      formContent.offsetHeight;
      formContent.addEventListener('transitionend', function onAppear(ev) {
        if (ev.target !== formContent || ev.propertyName !== 'opacity') return;
        formContent.removeEventListener('transitionend', onAppear);
        formContent.classList.remove('auth-content-appear');
      });
    }
  });

  bindAuth(toSignup);
}

/** Load reCAPTCHA script and render widget into container. Resolves when widget is ready. */
function loadRecaptchaAndRender(siteKey, container) {
  return new Promise((resolve, reject) => {
    if (window.grecaptcha && window.grecaptcha.render) {
      try {
        const widgetId = window.grecaptcha.render(container, { sitekey: siteKey, theme: 'light' });
        resolve(widgetId);
      } catch (err) {
        reject(err);
      }
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://www.google.com/recaptcha/api.js?onload=__recaptchaOnLoad&render=explicit';
    script.async = true;
    script.defer = true;
    window.__recaptchaOnLoad = () => {
      try {
        const widgetId = window.grecaptcha.render(container, { sitekey: siteKey, theme: 'light' });
        resolve(widgetId);
      } catch (err) {
        reject(err);
      }
    };
    document.head.appendChild(script);
  });
}

function bindAuth(isSignup) {
  const isRegister = !!isSignup;
  document.querySelectorAll('.auth-box .auth-switch-link').forEach(link => {
    link.addEventListener('click', (e) => { e.preventDefault(); navigateTo(link.getAttribute('href')); });
  });
  const form = document.getElementById('auth-form');
  if (!form) return;
  let recaptchaWidgetId = null;
  if (isRegister) {
    loadConfig().then((config) => {
      const wrap = document.getElementById('auth-recaptcha-wrap');
      if (wrap && config?.recaptchaSiteKey) {
        loadRecaptchaAndRender(config.recaptchaSiteKey, wrap).then((id) => { recaptchaWidgetId = id; }).catch(() => {});
      }
    });
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    const form = e.target;
    errEl.textContent = '';
    if (isRegister) {
      const display_name = (form.display_name?.value || '').trim();
      const username = (form.reg_username?.value || '').trim().toLowerCase();
      const email = (form.email?.value || '').trim();
      const password = form.reg_password?.value || '';
      const confirm = form.confirm_password?.value || '';
      if (!display_name) { errEl.textContent = 'Display name is required'; return; }
      if (!username) { errEl.textContent = 'Username is required'; return; }
      if (!email) { errEl.textContent = 'Email is required'; return; }
      if (!password) { errEl.textContent = t('passwordRequired'); return; }
      if (password !== confirm) { errEl.textContent = t('passwordsDoNotMatch'); return; }
      let recaptchaToken = null;
      if (state.recaptchaSiteKey && window.grecaptcha) {
        try {
          recaptchaToken = recaptchaWidgetId != null ? window.grecaptcha.getResponse(recaptchaWidgetId) : window.grecaptcha.getResponse();
        } catch { recaptchaToken = ''; }
      }
      if (state.recaptchaSiteKey && !recaptchaToken) {
        errEl.textContent = 'Please complete the reCAPTCHA check.';
        return;
      }
      try {
        const body = { username, email, password, display_name };
        if (recaptchaToken != null) body.recaptcha_token = recaptchaToken;
        const data = await doLogin(true, body);
        if (data.user) {
          state.user = data.user;
          try {
            await loadGroup();
            await loadUsers();
            await loadFriends();
            await loadBlocks();
            setTimeout(() => connectSocket(), 200);
          navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
        }
      } else throw new Error(data.error || 'Sign up failed');
      } catch (err) {
        errEl.textContent = err.message || 'Failed';
        if (state.recaptchaSiteKey && window.grecaptcha && recaptchaWidgetId != null) {
          try { window.grecaptcha.reset(recaptchaWidgetId); } catch (_) {}
        }
      }
      return;
    }
    const usernameOrEmail = (form.login_identifier?.value || '').trim();
    const password = form.login_password?.value || '';
    if (!usernameOrEmail) { errEl.textContent = 'Username or email is required'; return; }
    if (!password) { errEl.textContent = t('passwordRequired'); return; }
    try {
      const data = await doLogin(false, { username: usernameOrEmail, password });
      if (data.user) {
        state.user = data.user;
        try {
          await loadGroup();
          await loadUsers();
          await loadFriends();
          await loadBlocks();
          setTimeout(() => connectSocket(), 200);
          navigateTo(getRedirectOrDefault());
        } catch (e) {
          state.user = null;
          state.authError = e.message || 'Session could not be established. Please try again.';
          navigateTo(authPath('login', getPath()));
        }
      } else throw new Error(data.error || 'Login failed');
    } catch (err) {
      errEl.textContent = err.message || 'Failed';
    }
  };
}

async function doLogin(isRegister, body) {
  const url = isRegister ? '/api/auth/register' : '/api/auth/login';
  let res;
  try {
    res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  } catch (err) {
    throw new Error(err.message || 'Network error. Please check your connection.');
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(res.ok ? 'Invalid response from server.' : 'Login failed. Please try again.');
  }
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed.');
  if (data.user) state.user = data.user;
  return data;
}

function renderMain() {
  const route = parseRoute();
  const page = route.page;
  const primaryNav = getPrimaryNav(route);
  const panels = state.group?.panels || ['announcements', 'free_chat', 'support', 'problem_solving', 'rules'];
  const panelLabels = { free_chat: t('freeChat'), support: t('support'), problem_solving: t('problemSolving'), rules: t('rules'), announcements: t('announcements') };
  const isDocPanel = state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements';
  const isGroup = !!route.group;
  const expanded = state.leftBarExpanded;

  const panelExpanded = state.panelColumnExpanded;
  return `
    <div class="app-shell">
      <div class="app-shell-inner">
      <div class="panel-column ${panelExpanded ? 'panel-column-expanded' : ''}" id="panel-column">
        <button type="button" class="panel-column-toggle" id="panel-column-toggle" title="${panelExpanded ? 'Close panels' : 'Open panels'}" aria-label="${panelExpanded ? 'Close panels' : 'Open panels'}">
          <span class="left-bar-icon" aria-hidden="true">${panelExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
        </button>
        <div class="panel-column-overlay" id="panel-column-overlay" aria-hidden="true"></div>
        <div class="panel-column-content">
        ${primaryNav === 'home' ? `
        <div class="panel-list">
          <h3 class="panel-list-title">JimmyQrg</h3>
          <ul class="panel-list-ul">
            ${panels.map(p => {
              const isChat = p === 'free_chat' || p === 'support';
              const hasNew = isChat && getNewCount('group', p) > 0;
              return `<li><a href="/chat/group/?panel=${PANEL_TO_URL[p] || p}" class="panel-list-link ${state.panel === p ? 'active' : ''}"><span class="panel-list-hash">#</span> ${escapeHtml(panelLabels[p] || p)}${hasNew ? '<span class="panel-list-badge panel-list-badge-dot" aria-label="New"></span>' : ''}</a></li>`;
            }).join('')}
          </ul>
          </div>
        ` : ''}
        ${primaryNav === 'chat' ? `
        <div class="panel-list panel-list-users">
          <div class="panel-list-header">
            <h3 class="panel-list-title">${t('chat')}</h3>
            <button type="button" class="panel-search-btn" id="panel-search-btn" title="Search users">${ICON_SEARCH}</button>
        </div>
          <div class="panel-search-bar ${state.panelSearchOpen ? 'open' : ''}" id="panel-search-bar">
            <input type="search" id="panel-user-search" placeholder="Search users…" />
          </div>
          <ul class="panel-list-ul" id="panel-user-list">
            ${(function() {
              const users = (state.users || []).filter(u => u.id !== state.user?.id && !isBlocked(u.id));
              const convId = (uid) => state.convByUserId[uid];
              const lastMessageAt = (uid) => { const fromApi = state.lastMessageAtByUserId?.[uid]; if (fromApi != null) return fromApi; const c = convId(uid); if (!c) return 0; const list = state.messages['dm:' + c]; return list?.length ? Math.max(...list.map(m => m.created_at || 0)) : 0; };
              const newCount = (uid) => { const c = convId(uid); return c ? getNewCount('dm', c) : 0; };
              const name = (u) => (u.display_name || u.username || '').toLowerCase();
              /* Private chat list order: last chat time (recent first) > new message count (high first) > alphabetical */
              users.sort((a, b) => {
                const at = lastMessageAt(a.id), bt = lastMessageAt(b.id);
                if (bt !== at) return bt - at;
                const an = newCount(a.id), bn = newCount(b.id);
                if (bn !== an) return bn - an;
                return name(a).localeCompare(name(b));
              });
              return users.map(u => {
                const friend = isFriend(u.id);
                const defAv = getDefaultAvatarUrl(u.id);
                const avSrc = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAv;
                const n = newCount(u.id);
                const badge = n > 0 ? `<span class="panel-list-badge panel-list-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : '';
                const chatHref = `/chat/${encodeURIComponent(u.id)}${friend ? '' : '?view=profile'}`;
                return `
              <li><a href="${chatHref}" class="panel-list-link ${state.dmUserId === u.id ? 'active' : ''}" data-user-id="${escapeHtml(u.id)}" data-username="${escapeHtml((u.username || '').toLowerCase())}" data-display="${escapeHtml(name(u))}" data-friend="${friend ? '1' : '0'}">
                <span class="panel-user-avatar-wrap" data-user-id="${escapeHtml(u.id)}" title="View profile"><img src="${avSrc}" data-fallback="${defAv.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="panel-user-avatar" /></span>
                <span class="panel-list-link-text">${escapeHtml(u.display_name || u.username)}</span>${badge}
              </a></li>
            `; }).join('');
            })()}
          </ul>
        </div>
      ` : ''}
        ${primaryNav === 'admin' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('admin')}</h3>
          <a href="/manage?tab=action" class="panel-tab ${(route.adminTab || 'action') === 'action' ? 'active' : ''}">${t('action')}</a>
          <a href="/manage?tab=users" class="panel-tab ${route.adminTab === 'users' ? 'active' : ''}">${t('users')}</a>
          <a href="/manage?tab=recalled" class="panel-tab ${route.adminTab === 'recalled' ? 'active' : ''}">${t('recalled')}</a>
          <a href="/manage?tab=timeout" class="panel-tab ${route.adminTab === 'timeout' ? 'active' : ''}">${t('timeout')}</a>
        </div>
        ` : ''}
        ${primaryNav === 'settings' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('settings')}</h3>
          <a href="/settings?tab=general" class="panel-tab ${route.tab === 'general' ? 'active' : ''}">${t('general')}</a>
          <a href="/settings?tab=profile" class="panel-tab ${(route.tab || 'profile') === 'profile' ? 'active' : ''}">${t('profile')}</a>
          <a href="/settings?tab=notifications" class="panel-tab ${route.tab === 'notifications' ? 'active' : ''}">${t('notifications')}</a>
          <a href="/settings?tab=account" class="panel-tab ${route.tab === 'account' ? 'active' : ''}">${t('account')}</a>
        </div>
        ` : ''}
        ${primaryNav === 'inbox' ? `
        <div class="panel-tabs">
          <h3 class="panel-list-title">${t('inbox')}</h3>
        </div>
        ` : ''}
        </div>
      </div>

      <div class="main-content">
        <div class="main-content-body">
          ${primaryNav === 'home' ? (isGroup && (state.panel === 'free_chat' || state.panel === 'support') ? renderChatArea() : isGroup && isDocPanel ? renderDocArea() : `<div class="empty-state">${t('selectPanel')}</div>`) : ''}
          ${primaryNav === 'chat' ? (state.dmUserId ? renderChatArea() : `<div class="empty-state"><i class="fas fa-comments empty-state-icon" aria-hidden="true"></i><span>${t('selectConversation')}</span></div>`) : ''}
          ${primaryNav === 'inbox' ? renderInboxContent() : ''}
          ${primaryNav === 'admin' ? renderAdminContent() : ''}
          ${primaryNav === 'settings' ? renderSettingsContent() : ''}
        </div>
      </div>
      </div>

      <aside class="left-bar ${expanded ? 'left-bar-expanded' : ''}" id="left-bar">
        <div class="left-bar-avatar">
          <a href="/settings?tab=profile" class="left-bar-avatar-link" title="${t('profile')}">
            <img src="${getCurrentUserAvatarUrl()}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
          </a>
        </div>
        <nav class="left-bar-nav" aria-label="Main">
          <a href="/chat/group/" class="left-bar-item ${primaryNav === 'home' ? 'active' : ''}" title="Home (JimmyQrg group chat)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_HOME}</span>${hasNewGroupMessages() ? '<span class="left-bar-badge left-bar-badge-dot" aria-label="New messages"></span>' : ''}</span>
            <span class="left-bar-label">${t('home')}</span>
          </a>
          <a href="/chat" class="left-bar-item ${primaryNav === 'chat' ? 'active' : ''}" title="${t('chat')} (private messages)">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_CHAT}</span>${(function(){ const n = getTotalNewDmCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} new">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">${t('chat')}</span>
          </a>
          <a href="/inbox" class="left-bar-item ${primaryNav === 'inbox' ? 'active' : ''}" title="${t('inbox')}">
            <span class="left-bar-icon-wrap"><span class="left-bar-icon" aria-hidden="true">${ICON_INBOX}</span>${(function(){ const n = getUnreadInboxCount(); return n > 0 ? `<span class="left-bar-badge left-bar-badge-count" aria-label="${n} unread">${n > 99 ? '99+' : n}</span>` : ''; })()}</span>
            <span class="left-bar-label">${t('inbox')}</span>
          </a>
          ${state.user?.is_allowed ? `
          <a href="/manage" class="left-bar-item ${primaryNav === 'admin' ? 'active' : ''}" title="Admin">
            <span class="left-bar-icon" aria-hidden="true">${ICON_ADMIN}</span>
            <span class="left-bar-label">${t('admin')}</span>
          </a>
          ` : ''}
          <a href="/settings?tab=profile" class="left-bar-item ${primaryNav === 'settings' ? 'active' : ''}" title="${t('settings')}">
            <span class="left-bar-icon" aria-hidden="true">${ICON_SETTINGS}</span>
            <span class="left-bar-label">${t('settings')}</span>
          </a>
        </nav>
        <div class="left-bar-bottom">
          <button type="button" class="left-bar-expand" id="left-bar-expand" title="${expanded ? t('collapse') : t('expand')}">
            <span class="left-bar-icon" aria-hidden="true">${expanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT}</span>
            <span class="left-bar-label">${expanded ? t('collapse') : t('expand')}</span>
          </button>
        </div>
        </aside>
      ${state._recording ? `
      <div id="recording-overlay" class="recording-overlay">
        <div class="recording-overlay-backdrop"></div>
        <div class="recording-overlay-content">
          <p class="recording-overlay-title">${t('recording')}</p>
          <div class="recording-overlay-actions">
            <button type="button" id="recording-cancel" class="btn-secondary">${t('cancel')}</button>
            <button type="button" id="recording-send" class="btn-primary">${t('send')}</button>
          </div>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

const ICON_HOME = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const ICON_CHAT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const ICON_INBOX = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
const ICON_ADMIN = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
const ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-1.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h1.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v1.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-1.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_CHEVRON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_CHEVRON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_SEARCH = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
const ICON_MIC = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
const ICON_COMMAND = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6 9 12 15 18"/><path d="M9 6h6"/></svg>';
const ICON_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
const ICON_PREV = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/><path d="M9 18V6"/></svg>';
const ICON_NEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/><path d="M15 6v12"/></svg>';
const ICON_REWIND = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
const ICON_FORWARD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

function renderProfileView(userId) {
  const pv = state._profileView;
  if (!pv || pv.userId !== userId) return '<div class="profile-view-loading">' + t('loading') + '</div>';
  if (pv.error) return `<div class="profile-view-error">${escapeHtml(pv.error)}</div>`;
  if (pv.loading || !pv.profile) return '<div class="profile-view-loading">' + t('loading') + '</div>';
  const profile = pv.profile;
  const avatarUrl = (profile.avatar_url && String(profile.avatar_url).trim()) ? profile.avatar_url : getDefaultAvatarUrl(profile.id);
  const chatHref = `/chat/${encodeURIComponent(userId)}`;
  return `
    <div class="profile-view">
      <div class="profile-view-header">
        <a href="${chatHref}" class="profile-view-back">← ${t('chat')}</a>
      </div>
      <div class="profile-view-body settings-form">
        <div class="profile-view-avatar-wrap">
          <img src="${escapeHtml(avatarUrl)}" data-fallback="${getDefaultAvatarUrl(profile.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="profile-view-avatar" />
        </div>
        <div class="profile-view-field">
          <span class="profile-view-label">${t('displayName')}</span>
          <span class="profile-view-value">${escapeHtml(profile.display_name || profile.username || '')}</span>
        </div>
        <div class="profile-view-field">
          <span class="profile-view-label">${t('username')}</span>
          <span class="profile-view-value">@${escapeHtml(profile.username || '')}</span>
        </div>
        ${profile.description ? `
        <div class="profile-view-field">
          <span class="profile-view-label">${t('description')}</span>
          <span class="profile-view-value">${escapeHtml(profile.description)}</span>
        </div>
        ` : ''}
        ${profile.website ? `
        <div class="profile-view-field">
          <span class="profile-view-label">${t('website')}</span>
          <span class="profile-view-value"><a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">${escapeHtml(profile.website)}</a></span>
        </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderChatArea() {
  const route = parseRoute();
  const isProfileView = route.dmUserId && route.view === 'profile';
  if (isProfileView) {
    const profileContent = renderProfileView(route.dmUserId);
    return `
    <div class="chat-area chat-area-profile-view">
    <div class="messages-wrap messages-wrap-profile-view" data-room-type="dm" data-room-id="${state.convId || ''}">
      ${profileContent}
    </div>
    ${`
    <div class="composer composer-profile-view ${!isFriend(route.dmUserId) ? 'composer-no-files' : ''}" id="composer-drop-zone" data-can-send-files="${isFriend(route.dmUserId)}">
      <div class="composer-row">
        <div class="composer-input-wrap">
          <textarea id="composer-input" placeholder="Message…" rows="1"></textarea>
          <div class="composer-actions">
            <button type="button" id="composer-mic" title="Record voice message" ${!isFriend(route.dmUserId) ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
            <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
            <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
          </div>
        </div>
        <button type="button" class="composer-send" id="send-btn" ${state._spamBlockedUntil && Date.now() < state._spamBlockedUntil ? 'disabled' : ''}>Send</button>
      </div>
    </div>
    `}
    </div>
    `;
  }

  const roomType = state.dmUserId ? 'dm' : 'group';
  const roomId = state.dmUserId ? state.convId : state.panel;
  const key = roomKey(roomType, state.dmUserId ? state.convId : state.panel);
  const list = state.messages[key] || [];
  const replyPreview = state.replyTo ? getReplyPreview(state.replyTo) : null;

  const loading = state._loadingMessages?.[key];
  const accessDenied = roomType === 'group' && state.blacklisted;
  const emptyContent = accessDenied
    ? '<div class="messages-access-denied">Access denied. You are blacklisted from group chat. You can only private chat with JimmyQrg or allowed users.</div>'
    : loading
      ? Array(5).fill(0).map((_, i) => `
        <div class="message-skeleton" key="${i}">
          <div class="message-skeleton-avatar"></div>
          <div class="message-skeleton-body">
            <div class="message-skeleton-line message-skeleton-line-short"></div>
            <div class="message-skeleton-line"></div>
            <div class="message-skeleton-line message-skeleton-line-medium"></div>
          </div>
        </div>
      `).join('')
      : list.length === 0
        ? '<div class="messages-empty">No messages yet.</div>'
        : renderMessagesWithTimestamps(list, roomType, roomId);

  const deletedUserBanner = roomType === 'dm' && state.dmUserId && isUserDeleted(state.dmUserId)
    ? '<div class="deleted-user-banner">This account has been deleted.</div>'
    : '';

  return `
    <div class="chat-area">
    ${deletedUserBanner}
    <div class="messages-wrap" data-room-type="${roomType}" data-room-id="${roomId}">
      ${emptyContent}
    </div>
    <button type="button" class="scroll-to-bottom" aria-label="Scroll to bottom" title="Scroll to bottom" style="display:none">
      <span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></span>
    </button>
    ${!accessDenied && ((roomType === 'group' && (state.panel === 'free_chat' || state.panel === 'support')) || roomType === 'dm') ? `
    <div class="composer ${roomType === 'dm' && !isFriend(state.dmUserId) ? 'composer-no-files' : ''}" id="composer-drop-zone" data-can-send-files="${roomType === 'dm' ? isFriend(state.dmUserId) : true}">
      ${replyPreview ? `
        <div class="composer-reply">
          Replying to ${escapeHtml(replyPreview.sender)}: ${escapeHtml(replyPreview.content?.slice(0, 50) || '')}…
          <button type="button" id="cancel-reply" class="cancel-reply-link">Cancel</button>
        </div>
      ` : ''}
      ${state._pendingFile ? `
        <div class="composer-pending-file" id="pending-file-indicator">
          <span>Attached: ${escapeHtml(state._pendingFile.name)}</span>
          <button type="button" id="clear-pending-file" title="Remove"><span class="icon icon-sm" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></span></button>
        </div>
      ` : ''}
      <div class="composer-row">
        <div class="composer-input-wrap">
          <textarea id="composer-input" placeholder="Message…" rows="1"></textarea>
          <div class="composer-actions">
            ${roomType === 'group' ? `<button type="button" id="composer-command-mode" class="composer-command-btn ${state.commandMode ? 'composer-command-btn-on' : ''}" title="${state.commandMode ? 'Command mode on (e.g. /games, /wordle, /file &lt;id&gt;)' : 'Command mode off (send as text)'}" aria-label="Toggle command mode" aria-pressed="${state.commandMode}"><span class="icon" aria-hidden="true">${ICON_COMMAND}</span></button>` : ''}
            <button type="button" id="composer-mic" title="Record voice message" ${(roomType === 'dm' && !isFriend(state.dmUserId)) ? 'disabled' : ''}><span class="icon" aria-hidden="true">${ICON_MIC}</span></button>
            <button type="button" id="attach-file" title="Attach file"><span class="icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span></button>
            <input type="file" id="file-input" class="hidden-input" accept="image/*,video/*,audio/*,*/*" />
          </div>
        </div>
        <button type="button" class="composer-send" id="send-btn" ${state._spamBlockedUntil && Date.now() < state._spamBlockedUntil ? 'disabled' : ''}>Send</button>
      </div>
    </div>
    ` : ''}
    </div>
  `;
}

function getReplyPreview(msg) {
  if (!msg) return null;
  return { sender: msg.display_name || msg.username || 'Unknown user', content: msg.content };
}

const TS_INTERVAL_MS = 15 * 60 * 1000; // today: 15 min
const TS_INTERVAL_DAY_MS = 24 * 60 * 60 * 1000; // other days: 1 day

function formatTimestampForDivider(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderTimestamp(ts) {
  const text = escapeHtml(formatTimestampForDivider(ts));
  return `
    <div class="message-timestamp">
      <span class="message-timestamp-line"></span>
      <span class="message-timestamp-text">${text}</span>
      <span class="message-timestamp-line"></span>
    </div>
  `;
}

/** Parse file ref: /file <id> → { fileId, url }. /uploads/<id> only for legacy file messages (msg_type file/image/video/audio). */
function parseFileRef(content, msgType) {
  const s = (content || '').trim();
  if (s.startsWith('/file ')) {
    const fileId = s.slice(6).trim();
    if (fileId) return { fileId, url: `/uploads/${fileId}` };
  }
  const isLegacyFile = /^(file|image|video|audio|gif)$/i.test(msgType || '');
  if (isLegacyFile && s.startsWith('/uploads/')) {
    const fileId = s.slice('/uploads/'.length).split(/[?#]/)[0].trim();
    if (fileId) return { fileId, url: `/uploads/${fileId}` };
  }
  return null;
}

function isFileMessage(m) {
  return !!parseFileRef(m.content, m.msg_type);
}

function isMediaMessage(m) {
  const ref = parseFileRef(m.content, m.msg_type);
  if (!ref) return false;
  const k = getFileKind(m, ref.url);
  return k === 'video' || k === 'image' || k === 'gif';
}
function getMediaMessageIds(list) {
  return (list || []).filter(isMediaMessage).map(m => m.id);
}

function getFileKind(msg, urlOverride) {
  const type = (msg.msg_type || '').toLowerCase();
  const url = (urlOverride || msg.content || '').toLowerCase();
  if (type === 'video' || /\.(mp4|webm|mov|ogg)(\?|$)/.test(url)) return 'video';
  if (type === 'audio' || type === 'voice' || /\.(mp3|wav|ogg|webm|m4a)(\?|$)/.test(url)) return 'audio';
  if (type === 'image' || type === 'gif' || /\.(gif|jpg|jpeg|png|webp)(\?|$)/.test(url)) return url.includes('.gif') ? 'gif' : 'image';
  return 'file';
}

function renderFileBlock(msg, mediaContext) {
  const ref = parseFileRef(msg.content, msg.msg_type);
  if (!ref) return `<div class="message-content">${escapeHtml((msg.content || '').trim())}</div>`;
  const url = ref.url;
  const kind = getFileKind(msg, url);
  const safeUrl = escapeHtml(url).replace(/"/g, '&quot;');
  const { mediaIds = [], currentIndex = -1 } = mediaContext || {};
  const prevId = currentIndex > 0 ? mediaIds[currentIndex - 1] : null;
  const nextId = currentIndex >= 0 && currentIndex < mediaIds.length - 1 ? mediaIds[currentIndex + 1] : null;

  if (kind === 'video') {
    return `
      <div class="message-file message-file-video" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <video class="message-file-video-thumb" src="${safeUrl}" preload="metadata" muted playsinline></video>
        <span class="message-file-video-play" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
        <a href="${safeUrl}" download class="message-file-download message-file-download-video" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'image' || kind === 'gif') {
    return `
      <div class="message-file message-file-image" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}"
           data-prev-media-id="${prevId || ''}" data-next-media-id="${nextId || ''}" role="button" tabindex="0">
        <img class="message-file-image-img" src="${safeUrl}" alt="" loading="lazy" />
        <a href="${safeUrl}" download class="message-file-download message-file-download-image" onclick="event.stopPropagation()" title="Download">${ICON_DOWNLOAD}</a>
      </div>`;
  }
  if (kind === 'audio') {
    return `
      <div class="message-file message-file-audio" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
        <div class="message-file-audio-wrap">
          <audio class="message-file-audio-el" src="${safeUrl}" preload="metadata"></audio>
          <div class="message-file-audio-progress-wrap">
            <input type="range" class="message-file-audio-progress" min="0" max="100" value="0" title="Seek" />
          </div>
          <p class="message-file-audio-time">Current: <span class="message-file-audio-current">00:00</span> / Total: <span class="message-file-audio-total">00:00</span></p>
          <a href="${safeUrl}" download class="message-file-audio-download" title="Download">${ICON_DOWNLOAD}</a>
        </div>
      </div>`;
  }
  return `
    <div class="message-file message-file-other" data-msg-id="${escapeHtml(msg.id)}" data-url="${safeUrl}">
      <div class="message-file-other-wrap">
        <button type="button" class="message-file-other-icon" title="View file content" aria-label="View file">${ICON_FILE}</button>
        <a href="${safeUrl}" download class="message-file-other-download" title="Download">${ICON_DOWNLOAD}</a>
      </div>
    </div>`;
}

const ICON_DOWNLOAD = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
const ICON_FILE = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>';

function renderMessagesWithTimestamps(list, roomType, roomId) {
  let lastTs = null;
  const mediaIds = getMediaMessageIds(list);
  const parts = [];
  const todayStr = new Date().toDateString();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const t = m.created_at || 0;
    const isToday = t && new Date(t).toDateString() === todayStr;
    const intervalMs = isToday ? TS_INTERVAL_MS : TS_INTERVAL_DAY_MS;
    if (t && (lastTs == null || t - lastTs >= intervalMs)) {
      parts.push(renderTimestamp(t));
      lastTs = t;
    } else if (t) lastTs = t;
    const mediaIndex = mediaIds.indexOf(m.id);
    parts.push(renderMessage(m, roomType, roomId, { mediaIds, mediaIndex }));
  }
  return parts.join('');
}

function renderMessage(m, roomType, roomId, context = {}) {
  const isOwn = m.sender_id === state.user?.id;
  const isFileMessage = !!parseFileRef(m.content, m.msg_type);

  if (m.deleted_by_admin) {
    return `
      <div class="message message-system" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text">Message deleted</span>
      </div>
    `;
  }

  if (m.recalled_at) {
    const name = escapeHtml(m.display_name || m.username || 'Unknown user');
    return `
      <div class="message message-system message-recalled-line" data-msg-id="${m.id}" data-sender-id="${m.sender_id || ''}">
        <span class="message-system-text"><span class="message-recalled-name">${name}</span> recalled a message</span>
      </div>
    `;
  }

  const versions = [...(m.edit_history || []).map(h => h.content), m.content || ''];
  const versionIndex = Math.max(0, Math.min((state.messageVersionIndex[m.id] ?? versions.length - 1), versions.length - 1));
  const displayContent = versions[versionIndex];
  const mediaContext = { mediaIds: context.mediaIds || [], currentIndex: context.mediaIndex ?? -1 };
  const content = isFileMessage ? renderFileBlock(m, mediaContext) : renderMessageContent(displayContent || '');
  const replyBlock = m.reply_to_id ? `<div class="message-reply-preview" data-reply-to="${m.reply_to_id}">${t('replyToMessage')}</div>` : '';
  const likeCount = (m.likes || 0) > 0 ? `<span class="message-like-count">${m.likes}</span>` : '';
  const likeIcon = `<button type="button" class="message-like-btn" data-msg-id="${m.id}" title="Like" aria-label="Like"><span class="message-like-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg></span></button>`;

  const chevronLeft = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`;
  const chevronRight = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>`;
  const editHistoryUI = !isFileMessage && versions.length > 1
    ? `<span class="message-edit-history" data-msg-id="${m.id}">
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="prev" title="Older version" aria-label="Older version" ${versionIndex <= 0 ? 'disabled' : ''}>${chevronLeft}</button>
        <span class="message-edit-history-label">${versionIndex + 1}/${versions.length}</span>
        <button type="button" class="message-edit-history-btn" data-msg-id="${m.id}" data-dir="next" title="Newer version" aria-label="Newer version" ${versionIndex >= versions.length - 1 ? 'disabled' : ''}>${chevronRight}</button>
      </span>`
    : '';

  const isEditing = !isFileMessage && state.editingMessageId === m.id;
  const contentBlock = isEditing
    ? `<div class="message-edit-area">
        <textarea class="message-edit-input" data-msg-id="${m.id}" rows="3">${escapeHtml(m.content || '')}</textarea>
        <div class="message-edit-actions">
          <button type="button" class="message-edit-save" data-msg-id="${m.id}">Save</button>
          <button type="button" class="message-edit-cancel" data-msg-id="${m.id}">Cancel</button>
        </div>
      </div>`
    : `<div class="message-content message-content-file">${content}</div>`;

  const defaultAvatar = getDefaultAvatarUrl(m.sender_id);
  const avatarSrc = (m.avatar_url && String(m.avatar_url).trim()) ? m.avatar_url : defaultAvatar;
  const senderName = escapeHtml(m.display_name || m.username || 'Unknown user');
  return `
    <div class="message-row" data-msg-id="${m.id}">
    <div class="message ${isOwn ? 'own' : ''}" data-msg-id="${m.id}" data-sender-id="${m.sender_id}">
        <div class="message-avatar-wrap" data-sender-id="${escapeHtml(m.sender_id || '')}" title="View profile" role="button" tabindex="0">
          <span class="message-sender">${senderName}</span>
          <img class="message-avatar" src="${avatarSrc}" data-fallback="${defaultAvatar.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" />
        </div>
        <div class="message-body">
        ${replyBlock}
          ${contentBlock}
        </div>
      </div>
      <div class="message-like-wrap">
        ${editHistoryUI}
        ${likeIcon}
        ${likeCount}
      </div>
    </div>
  `;
}

function renderDocArea() {
  const docKey = state.panel;
  const canEdit = state.user?.can_edit_docs;
  const isEditing = canEdit && state.editingDocKey === docKey;
  const supportId = state.supportMessageIdForSolve || '';
  const content = state._docContent ?? '';
  if (isEditing) {
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      <div class="doc-toolbar">
        <button type="button" id="save-doc" class="doc-save">Save</button>
        <button type="button" id="cancel-doc-edit" class="doc-cancel">Cancel</button>
      </div>
      <div class="doc-editor">
        <textarea id="doc-content" placeholder="${t('loading')}">${escapeHtml(content)}</textarea>
      </div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
  }
  return `
    <div class="doc-panel" data-doc-key="${docKey}">
      ${canEdit ? `
      <div class="doc-toolbar">
        <button type="button" id="start-doc-edit" class="doc-edit-btn">${t('edit')}</button>
      </div>
      ` : ''}
      <div class="doc-view doc-markdown">${markdownToHtml(content)}</div>
      <input type="hidden" id="doc-support-msg-id" value="${escapeHtml(supportId)}" />
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/** Parse $ [\] [ ](language|lang)=[ ]"name" ... \$ blocks. Supports $\language=, $\ lang=, $\ language =, etc. */
function parseLanguageBlocks(str) {
  if (str == null || str === '') return [{ type: 'text', content: '' }];
  const s = String(str);
  const re = /\$\s*\\?\s*(?:language|lang)\s*=\s*"([^"]+)"\s*\n([\s\S]*?)\\\$/g;
  const segments = [];
  let lastEnd = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastEnd) {
      segments.push({ type: 'text', content: s.slice(lastEnd, m.index) });
    }
    let lang = m[1].trim().toLowerCase();
    if (lang === 'md') lang = 'markdown';
    segments.push({ type: 'block', language: lang, content: m[2].replace(/\n$/, '') });
    lastEnd = re.lastIndex;
  }
  if (lastEnd < s.length) {
    segments.push({ type: 'text', content: s.slice(lastEnd) });
  }
  return segments.length ? segments : [{ type: 'text', content: s }];
}

/** Sanitize HTML to a safe subset of tags (no script, no event handlers). */
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const allowedTags = new Set(['p', 'div', 'span', 'br', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const allowedAttrs = { a: ['href', 'target'] };
  function serialize(n) {
    if (n.nodeType === Node.TEXT_NODE) return escapeHtml(n.textContent);
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = n.tagName.toLowerCase();
    if (!allowedTags.has(tag)) return Array.from(n.childNodes).map(serialize).join('');
    const attrs = allowedAttrs[tag];
    let attrStr = '';
    if (attrs && tag === 'a') {
      const href = n.getAttribute('href');
      if (href) attrStr = ' href="' + escapeHtml(href).replace(/"/g, '&quot;') + '"';
      const target = (n.getAttribute('target') || '').toLowerCase();
      if (target === '_blank' || target === 'blank') attrStr += ' target="_blank" rel="noopener"';
    }
    const inner = Array.from(n.childNodes).map(serialize).join('');
    if (tag === 'br') return '<br>';
    return '<' + tag + attrStr + '>' + inner + '</' + tag + '>';
  }
  return Array.from(doc.body.childNodes).map(serialize).join('');
}

/** Render LaTeX block to HTML using KaTeX if available. */
function renderLatexBlock(latex) {
  if (typeof window.renderKatex === 'function') {
    try {
      return window.renderKatex(latex, true);
    } catch (e) {
      return '<pre class="language-block-error">' + escapeHtml(latex) + '</pre>';
    }
  }
  return '<pre class="language-block-latex"><code>' + escapeHtml(latex) + '</code></pre>';
}

/** Process message content: apply language blocks then markdown.
 * Supports /plaintext: everything below that line is rendered as plain text.
 */
function renderMessageContent(raw) {
  if (raw == null || raw === '') return '';
  const lineSeparator = /\r\n|\r|\n/;
  const lines = String(raw).split(lineSeparator);
  const plaintextLineIndex = lines.findIndex((l) => {
    const t = l.trim().toLowerCase();
    return t === '/plaintext';
  });
  if (plaintextLineIndex >= 0) {
    const above = lines.slice(0, plaintextLineIndex).join('\n');
    const below = lines.slice(plaintextLineIndex + 1).join('\n');
    const aboveHtml = above ? renderMessageContentInner(above) : '';
    const belowHtml = below ? '<div class="message-content-plaintext">' + escapeHtml(below) + '</div>' : '';
    return aboveHtml + belowHtml;
  }
  return renderMessageContentInner(raw);
}

function renderMessageContentInner(raw) {
  if (raw == null || raw === '') return '';
  const segments = parseLanguageBlocks(raw);
  const parts = [];
  for (const seg of segments) {
    if (seg.type === 'text') {
      parts.push(markdownToHtml(seg.content));
    } else {
      const lang = seg.language;
      const content = seg.content;
      if (lang === 'markdown') {
        parts.push(markdownToHtml(content));
      } else if (lang === 'html') {
        parts.push('<div class="language-block-html">' + sanitizeHtml(content) + '</div>');
      } else if (lang === 'latex') {
        parts.push('<div class="language-block-latex">' + renderLatexBlock(content) + '</div>');
      } else {
        parts.push('<pre class="language-block-raw"><code>' + escapeHtml(content) + '</code></pre>');
      }
    }
  }
  return parts.join('');
}

/** Render Markdown to safe HTML (no raw HTML execution). Supports # headers, **bold**, *italic*, `code`, > blockquote, -, * lists, ``` blocks, [links](url). */
function markdownToHtml(md) {
  if (md == null || md === '') return '';
  const lines = String(md).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  let inBlock = false;
  let blockContent = [];
  let listItems = [];
  let listOrdered = false;
  let blockquoteLines = [];

  function flushBlock() {
    if (blockContent.length) {
      const code = escapeHtml(blockContent.join('\n'));
      out.push(`<pre><code>${code}</code></pre>`);
      blockContent = [];
    }
    inBlock = false;
  }
  function flushList() {
    if (listItems.length) {
      const tag = listOrdered ? 'ol' : 'ul';
      out.push(`<${tag}><li>${listItems.join(`</li><li>`)}</li></${tag}>`);
      listItems = [];
    }
  }
  function flushBlockquote() {
    if (blockquoteLines.length) {
      const html = blockquoteLines.map(l => `<p>${inlineMarkdown(l)}</p>`).join('');
      out.push(`<blockquote>${html}</blockquote>`);
      blockquoteLines = [];
    }
  }
  function linkifyPlainText(segment) {
    if (!segment || /^<a\s|^<\/a>/.test(segment)) return segment;
    const safeHref = (u) => u.replace(/"/g, '&quot;');
    // Linkify only plain text: split by existing <a>...</a>, process each text part, rejoin (avoids double-linking)
    const linkTag = /<a\s[^>]*>.*?<\/a>/g;
    const linkifyClass = ' class="linkify-link"';
    const linkifyPlainOnly = (text) => {
      if (!text) return text;
      return text
        .replace(/(?<![\/">])(www\.[^\s<>"']+)/g, (_, url) =>
          `<a href="${safeHref('https://' + url)}"${linkifyClass} target="_blank" rel="noopener">${url}</a>`)
        .replace(/\b([a-zA-Z0-9][-a-zA-Z0-9_]*\.github\.io(?:\/[^\s<>"']*)?)/g, (_, url) =>
          `<a href="${safeHref('https://' + url)}"${linkifyClass} target="_blank" rel="noopener">${url}</a>`)
        .replace(/\b(localhost(?::\d+)?(?:\/[^\s<>"']*)?)/gi, (_, u) =>
          `<a href="${safeHref('https://' + u)}"${linkifyClass} target="_blank" rel="noopener">${u}</a>`)
        .replace(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/[^\s<>"']*)?)/g, (_, u) =>
          `<a href="${safeHref('https://' + u)}"${linkifyClass} target="_blank" rel="noopener">${u}</a>`)
        .replace(/\b((?:[a-zA-Z0-9][-a-zA-Z0-9_]*\.)+[a-zA-Z0-9][-a-zA-Z0-9_]*(?::\d+)?(?:\/?[^\s<>"']*)?)\b/g, (_, url) => {
          const tldMatch = url.match(/\.(com|org|net|io|co|edu|gov|dev|app|ai|site|xyz|test|local|internal)(?:\/|:\d+|\?|#|$)/i);
          if (!tldMatch) return url;
          if (url === 'github.io') return url;
          return `<a href="${safeHref('https://' + url)}"${linkifyClass} target="_blank" rel="noopener">${url}</a>`;
        });
    };
    const linkifyOne = (text) => {
      if (!text) return text;
      const withScheme = text.replace(/(https?:\/\/[^\s<>"']+)/g, (_, url) =>
        `<a href="${safeHref(url)}"${linkifyClass} target="_blank" rel="noopener">${url}</a>`);
      const parts = withScheme.split(linkTag);
      const links = withScheme.match(linkTag) || [];
      let out = linkifyPlainOnly(parts[0]);
      for (let i = 0; i < links.length; i++) {
        out += links[i] + linkifyPlainOnly(parts[i + 1]);
      }
      return out;
    };
    const parts = segment.split(linkTag);
    const links = segment.match(linkTag) || [];
    let out = linkifyOne(parts[0]);
    for (let i = 0; i < links.length; i++) {
      out += links[i] + linkifyOne(parts[i + 1]);
    }
    return out;
  }

  function inlineMarkdown(s) {
    const escaped = escapeHtml(s);
    const withMarkdown = escaped
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/`([^`]*)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const parts = withMarkdown.split(/(<a\s[^>]*>|<\/a>)/g);
    let inAnchor = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (/^<a\s/i.test(part)) {
        inAnchor = true;
        continue;
      }
      if (/^<\/a>/i.test(part)) {
        inAnchor = false;
        continue;
      }
      if (!inAnchor && part) {
        parts[i] = linkifyPlainText(part);
      }
    }
    return parts.join('');
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('```')) {
      flushBlockquote();
      flushList();
      if (inBlock) {
        flushBlock();
      } else {
        inBlock = true;
      }
      continue;
    }
    if (inBlock) {
      blockContent.push(line);
      continue;
    }
    if (blockquoteLines.length && !trimmed.startsWith('>')) {
      flushBlockquote();
    }
    const blockquoteMatch = trimmed.match(/^>\s?(.*)$/);
    if (blockquoteMatch) {
      flushList();
      blockquoteLines.push(blockquoteMatch[1]);
      continue;
    }
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (olMatch) {
      if (listItems.length && !listOrdered) flushList();
      listOrdered = true;
      listItems.push(inlineMarkdown(olMatch[2]));
      continue;
    }
    if (ulMatch) {
      if (listItems.length && listOrdered) flushList();
      listOrdered = false;
      listItems.push(inlineMarkdown(ulMatch[1]));
      continue;
    }
    flushList();
    if (trimmed.startsWith('### ')) {
      out.push(`<h3>${inlineMarkdown(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      out.push(`<h2>${inlineMarkdown(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      out.push(`<h1>${inlineMarkdown(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (trimmed === '') {
      out.push('<p></p>');
      continue;
    }
    out.push(`<p>${inlineMarkdown(trimmed)}</p>`);
  }
  flushBlock();
  flushList();
  flushBlockquote();
  return out.join('\n');
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatAudioTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function showProfileModal(userId) {
  if (!userId || userId === state.user?.id) return;
  document.querySelectorAll('.profile-modal-overlay').forEach((el) => el.remove());
  try {
    const { profile } = await apiGet(`/api/users/${encodeURIComponent(userId)}/profile`);
    const friend = isFriend(userId);
    const blocked = isBlocked(userId);
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay profile-modal-overlay';
    overlay.innerHTML = `
      <div class="modal profile-modal">
        <button type="button" class="profile-modal-close" aria-label="Close">&times;</button>
        <div class="profile-modal-scroll">
        <div class="profile-modal-header">
          <img src="${(profile.avatar_url && String(profile.avatar_url).trim()) ? profile.avatar_url : getDefaultAvatarUrl(profile.id)}" data-fallback="${getDefaultAvatarUrl(profile.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="profile-modal-avatar" />
          <h3 class="profile-modal-name">${escapeHtml(profile.display_name || profile.username)}</h3>
          <p class="profile-modal-username">@${escapeHtml(profile.username)}</p>
          ${profile.description ? `<p class="profile-modal-description">${escapeHtml(profile.description)}</p>` : ''}
          ${profile.website ? `<p class="profile-modal-website"><a href="${escapeHtml(profile.website)}" target="_blank" rel="noopener">${escapeHtml(profile.website)}</a></p>` : ''}
        </div>
        <div class="profile-modal-actions">
          <button type="button" class="btn-primary profile-btn-message">${t('sendMessage')}</button>
          ${!friend ? `<button type="button" class="btn-secondary profile-btn-friend-request">${t('sendFriendRequest')}</button>` : ''}
          <button type="button" class="btn-secondary profile-btn-block" data-blocked="${blocked}">${blocked ? t('unblock') : t('block')}</button>
        </div>
        </div>
      </div>
    `;
    const onEscape = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onEscape);
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.profile-modal-close')?.addEventListener('click', close);
    document.addEventListener('keydown', onEscape);
    overlay.querySelector('.profile-btn-message')?.addEventListener('click', () => { overlay.remove(); navigateTo(`/chat/${encodeURIComponent(userId)}`); });
    const blockBtn = overlay.querySelector('.profile-btn-block');
    if (blockBtn) {
      blockBtn.addEventListener('click', async () => {
        try {
          const blocked = blockBtn.dataset.blocked === 'true';
          if (blocked) {
            await apiDelete(`/api/blocks/${encodeURIComponent(userId)}`);
            state.blocked_ids = (state.blocked_ids || []).filter(id => id !== userId);
            blockBtn.textContent = t('block');
            blockBtn.dataset.blocked = 'false';
          } else {
            await apiPost('/api/blocks', { user_id: userId });
            state.blocked_ids = [...(state.blocked_ids || []), userId];
            blockBtn.textContent = t('unblock');
            blockBtn.dataset.blocked = 'true';
          }
        } catch (err) {
          showToast(err.message || 'Failed');
        }
      });
    }
    const frBtn = overlay.querySelector('.profile-btn-friend-request');
    if (frBtn) {
      frBtn.addEventListener('click', async () => {
        try {
          await apiPost('/api/friends/request', { to_user_id: userId });
          frBtn.textContent = t('requestSent');
          frBtn.disabled = true;
        } catch (err) {
          showToast(err.message || 'Failed to send friend request');
        }
      });
    }
    document.body.appendChild(overlay);
  } catch (err) {
    showToast(err.message || 'Could not load profile');
  }
}

function showWordleModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay wordle-modal-overlay';
  overlay.innerHTML = `
    <div class="wordle-modal">
      <button type="button" class="wordle-modal-close" aria-label="Close">&times;</button>
      <iframe src="https://jimmyqrg.github.io/wordle" title="Wordle" class="wordle-iframe"></iframe>
    </div>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.wordle-modal-close')?.addEventListener('click', close);
  const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function getStepOptions(durationSeconds) {
  if (durationSeconds <= 60) return [5];
  if (durationSeconds <= 180) return [5, 10];
  return [5, 10, 15];
}

function openMediaPopup(msgId, url, kind, prevId, nextId, roomType, roomId) {
  const existing = document.querySelector('.media-popup-overlay');
  if (existing) existing.remove();
  const list = state.messages[roomKey(roomType, roomId)] || [];
  const mediaList = list.filter(isMediaMessage);
  const safeUrl = (u) => escapeHtml(u || '').replace(/"/g, '&quot;');
  const overlay = document.createElement('div');
  overlay.className = 'media-popup-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  function setMedia(msg) {
    if (!msg) return;
    const u = (msg.content || '').trim();
    const k = getFileKind(msg);
    const prev = mediaList[mediaList.findIndex(m => m.id === msg.id) - 1];
    const next = mediaList[mediaList.findIndex(m => m.id === msg.id) + 1];
    const prevId = prev?.id || '';
    const nextId = next?.id || '';
    const contentEl = overlay.querySelector('.media-popup-content');
    const controlsEl = overlay.querySelector('.media-popup-controls');
    const imageOverlayEl = overlay.querySelector('.media-popup-image-overlay');
    const popupEl = overlay.querySelector('.media-popup');
    if (!contentEl || !controlsEl) return;
    contentEl.innerHTML = '';
    if (popupEl) popupEl.classList.toggle('media-popup--video', k === 'video');
    if (imageOverlayEl) imageOverlayEl.style.display = k === 'video' ? 'none' : '';
    if (k === 'video') {
      const steps = [5, 10, 15];
      const stepBtns = steps.map(s => `<button type="button" class="media-popup-step" data-sec="${s}" title="Back ${s}s" aria-label="Back ${s}s"><span class="icon icon-sm">${ICON_REWIND}</span><span class="media-popup-step-sec">${s}</span></button>`).join('');
      const stepFwd = steps.map(s => `<button type="button" class="media-popup-step-fwd" data-sec="${s}" title="Forward ${s}s" aria-label="Forward ${s}s"><span class="icon icon-sm">${ICON_FORWARD}</span><span class="media-popup-step-sec">${s}</span></button>`).join('');
      const vid = document.createElement('video');
      vid.className = 'media-popup-video';
      vid.src = u;
      vid.controls = false;
      vid.playsInline = true;
      contentEl.appendChild(vid);
      controlsEl.innerHTML = `
        <div class="media-popup-controls-row">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}" title="Previous" aria-label="Previous"><span class="icon icon-sm">${ICON_PREV}</span></button>
          <span class="media-popup-step-group">${stepBtns}</span>
          <button type="button" class="media-popup-play" title="Play (K)" aria-label="Play"><span class="icon icon-sm media-popup-play-icon">${ICON_PLAY}</span></button>
          <span class="media-popup-step-group">${stepFwd}</span>
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}" title="Next" aria-label="Next"><span class="icon icon-sm">${ICON_NEXT}</span></button>
          <a href="${safeUrl(u)}" download class="media-popup-download" title="Download" aria-label="Download"><span class="icon icon-sm">${ICON_DOWNLOAD}</span></a>
        </div>
      `;
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
      overlay.querySelector('.media-popup-play')?.addEventListener('click', () => { vid.paused ? vid.play() : vid.pause(); });
      overlay.querySelectorAll('.media-popup-step').forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.max(0, vid.currentTime - parseInt(btn.dataset.sec, 10)); }));
      overlay.querySelectorAll('.media-popup-step-fwd').forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.min(vid.duration, vid.currentTime + parseInt(btn.dataset.sec, 10)); }));
      vid.addEventListener('loadedmetadata', () => {
        const dur = vid.duration;
        const opts = getStepOptions(dur);
        const row = controlsEl.querySelector('.media-popup-controls-row');
        if (row) {
          const backGroup = row.querySelector('.media-popup-step-group');
          const fwdGroup = row.querySelectorAll('.media-popup-step-group')[1];
          if (backGroup) backGroup.innerHTML = opts.map(s => `<button type="button" class="media-popup-step" data-sec="${s}" title="Back ${s}s" aria-label="Back ${s}s"><span class="icon icon-sm">${ICON_REWIND}</span><span class="media-popup-step-sec">${s}</span></button>`).join('');
          if (fwdGroup) fwdGroup.innerHTML = opts.map(s => `<button type="button" class="media-popup-step-fwd" data-sec="${s}" title="Forward ${s}s" aria-label="Forward ${s}s"><span class="icon icon-sm">${ICON_FORWARD}</span><span class="media-popup-step-sec">${s}</span></button>`).join('');
          [...(row.querySelectorAll('.media-popup-step'))].forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.max(0, vid.currentTime - parseInt(btn.dataset.sec, 10)); }));
          [...(row.querySelectorAll('.media-popup-step-fwd'))].forEach(btn => btn.addEventListener('click', () => { vid.currentTime = Math.min(vid.duration, vid.currentTime + parseInt(btn.dataset.sec, 10)); }));
        }
      });
      vid.addEventListener('play', () => {
        const b = overlay.querySelector('.media-popup-play');
        const icon = b?.querySelector('.media-popup-play-icon');
        if (icon) icon.innerHTML = ICON_PAUSE;
        if (b) b.setAttribute('aria-label', 'Pause');
      });
      vid.addEventListener('pause', () => {
        const b = overlay.querySelector('.media-popup-play');
        const icon = b?.querySelector('.media-popup-play-icon');
        if (icon) icon.innerHTML = ICON_PLAY;
        if (b) b.setAttribute('aria-label', 'Play');
      });
      overlay._imageShowUI = null;
      overlay._imageHideUI = null;
    } else {
      controlsEl.innerHTML = `
        <div class="media-popup-image-ui media-popup-controls-row" role="toolbar">
          <button type="button" class="media-popup-prev" ${!prevId ? 'disabled' : ''} data-msg-id="${prevId}">Previous</button>
          <button type="button" class="media-popup-next" ${!nextId ? 'disabled' : ''} data-msg-id="${nextId}">Next</button>
          <a href="${safeUrl(u)}" download class="media-popup-download">${ICON_DOWNLOAD}</a>
        </div>
      `;
      controlsEl.classList.add('media-popup-image-ui');
      controlsEl.style.opacity = '0';
      const img = document.createElement('img');
      img.className = 'media-popup-image';
      img.src = u;
      img.alt = '';
      contentEl.appendChild(img);
      let scale = 1;
      let uiTimer = null;
      const isTouch = 'ontouchstart' in window;
      function showUI() {
        controlsEl.style.opacity = '1';
        if (uiTimer) clearTimeout(uiTimer);
        uiTimer = setTimeout(hideUI, 2000);
      }
      function hideUI() {
        controlsEl.style.opacity = '0';
        if (uiTimer) clearTimeout(uiTimer);
      }
      overlay._imageShowUI = showUI;
      overlay._imageHideUI = hideUI;
      overlay.querySelector('.media-popup-image-overlay')?.addEventListener('click', showUI);
      contentEl.addEventListener('click', showUI);
      contentEl.addEventListener('wheel', (e) => { e.preventDefault(); scale = Math.max(0.25, Math.min(4, scale + (e.deltaY > 0 ? -0.1 : 0.1))); img.style.transform = `scale(${scale})`; });
      overlay.querySelector('.media-popup-prev')?.addEventListener('click', () => { if (prev) setMedia(prev); });
      overlay.querySelector('.media-popup-next')?.addEventListener('click', () => { if (next) setMedia(next); });
    }
  }

  const initialMsg = list.find(m => m.id === msgId) || { content: url, msg_type: kind === 'video' ? 'video' : 'image' };
  const isVideo = kind === 'video';
  overlay.innerHTML = `
    <div class="media-popup">
      <button type="button" class="media-popup-close" aria-label="Close">&times;</button>
      <div class="media-popup-content"></div>
      <div class="media-popup-image-overlay"></div>
      <div class="media-popup-controls"></div>
    </div>
  `;
  const close = () => {
    overlay.querySelector('.media-popup-video')?.pause();
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === ' ') e.preventDefault();
    if (e.key === 'k' || e.key === 'K') {
      const v = overlay.querySelector('.media-popup-video');
      if (v) { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    }
  };
  overlay.querySelector('.media-popup-close')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target.closest('.media-popup-close')) close(); });
  document.addEventListener('keydown', onKey);
  setMedia(initialMsg);
  if (isVideo) {
    const v = overlay.querySelector('.media-popup-video');
    if (v) v.play().catch(() => {});
  }
  overlay.addEventListener('keydown', () => { overlay._imageShowUI?.(); });
  overlay.addEventListener('mousemove', (e) => {
    if (e.target.closest('.media-popup-content') || e.target.closest('.media-popup-controls')) overlay._imageShowUI?.();
  });
  overlay.addEventListener('mouseleave', () => {
    if (!('ontouchstart' in window)) overlay._imageHideUI?.();
  });
  document.body.appendChild(overlay);
}

async function openFileContentModal(url) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    const text = await res.text();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay file-content-modal-overlay';
    overlay.innerHTML = `
      <div class="modal file-content-modal">
        <button type="button" class="file-content-modal-close" aria-label="Close">&times;</button>
        <pre class="file-content-modal-body">${escapeHtml(text)}</pre>
        <a href="${escapeHtml(url).replace(/"/g, '&quot;')}" download class="file-content-modal-download">Download</a>
      </div>
    `;
    const onEscape = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEscape); } };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onEscape); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('.file-content-modal-close')?.addEventListener('click', close);
    document.addEventListener('keydown', onEscape);
    document.body.appendChild(overlay);
  } catch (e) {
    showToast('Could not load file content');
  }
}

function bindMain() {
  document.querySelector('.panel-column-content')?.addEventListener('click', (e) => {
    if (e.target.closest('a') && state.panelColumnExpanded) {
      state.panelColumnExpanded = false;
      setState({});
    }
  });

  document.getElementById('panel-search-btn')?.addEventListener('click', () => {
    setState({ panelSearchOpen: !state.panelSearchOpen });
  });

  const panelSearchInput = document.getElementById('panel-user-search');
  const panelUserList = document.getElementById('panel-user-list');
  if (panelSearchInput && panelUserList) {
    panelSearchInput.addEventListener('input', () => {
      const q = (panelSearchInput.value || '').trim().toLowerCase();
      panelUserList.querySelectorAll('a.panel-list-link').forEach((a) => {
        const match = !q || (a.dataset.username || '').includes(q) || (a.dataset.display || '').includes(q);
        a.closest('li').style.display = match ? '' : 'none';
      });
    });
    panelUserList.addEventListener('contextmenu', (e) => {
      const a = e.target.closest('a.panel-list-link[data-user-id]');
      if (!a) return;
      e.preventDefault();
      const userId = a.dataset.userId;
      const friend = a.dataset.friend === '1';
      const items = [
        { label: t('profile'), action: 'profile' },
        { label: t('chat'), action: 'chat' },
      ];
      if (!friend) items.push({ label: t('sendFriendRequest'), action: 'friend-request' });
      items.push({ label: t('block'), action: 'block', danger: true });
      showContextMenu(e.clientX, e.clientY, items, async (action) => {
        if (action === 'profile') navigateTo(`/chat/${encodeURIComponent(userId)}?view=profile`);
        else if (action === 'chat') navigateTo(`/chat/${encodeURIComponent(userId)}`);
        else if (action === 'friend-request') {
          try {
            await apiPost('/api/friends/request', { to_user_id: userId });
            await loadFriends();
            render();
          } catch (err) { showToast(err.message || 'Failed to send friend request'); }
        } else if (action === 'block') {
          try {
            await apiPost('/api/blocks', { user_id: userId });
            state.blocked_ids = [...(state.blocked_ids || []), userId];
            await loadFriends();
            render();
          } catch (err) { showToast(err.message); }
        }
      });
    });
  }

  document.getElementById('cancel-reply')?.addEventListener('click', () => setState({ replyTo: null }));

  const wrap = document.querySelector('.messages-wrap');
  const scrollBtn = document.querySelector('.scroll-to-bottom');
  const roomType = wrap?.dataset.roomType;
  const roomId = wrap?.dataset.roomId;
  if (wrap && roomType && roomId) {
    requestAnimationFrame(() => {
      wrap.scrollTop = wrap.scrollHeight;
    });
    function updateScrollToBottomVisibility() {
      if (!scrollBtn) return;
      const threshold = 80;
      const nearBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < threshold;
      scrollBtn.style.display = nearBottom ? 'none' : 'flex';
    }
    wrap.addEventListener('scroll', updateScrollToBottomVisibility);
    updateScrollToBottomVisibility();
    scrollBtn?.addEventListener('click', () => {
      wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
    });
    wrap.addEventListener('contextmenu', (e) => {
      const msgEl = e.target.closest('.message[data-msg-id]');
      if (!msgEl) return;
      e.preventDefault();
      const msgId = msgEl.dataset.msgId;
      const senderId = msgEl.dataset.senderId;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const isOwn = msg.sender_id === state.user?.id;
      const canRecallEdit = isOwn && msg.created_at && (Date.now() - msg.created_at) <= 2 * 60 * 1000;
      const isSupport = roomType === 'group' && roomId === 'support';
      const canSolve = state.user?.can_edit_docs && isSupport;

      const items = [];
      if (isOwn && canRecallEdit) {
        items.push({ label: t('recall'), action: 'recall' });
        items.push({ label: t('edit'), action: 'edit' });
      }
      if (isOwn) items.push({ label: t('delete'), action: 'delete', danger: true });
      if (state.user?.can_delete_messages && !isOwn && senderId !== 'jimmyqrg') items.push({ label: t('adminDeleteAdmin'), action: 'delete', danger: true });
      if (state.user?.can_kick && senderId !== 'jimmyqrg') items.push({ label: t('adminRemoveAccount'), action: 'remove-account' });
      if (canSolve) items.push({ label: t('solve'), action: 'solve' });
      const fileRef = parseFileRef(msg.content, msg.msg_type);
      if (fileRef) items.push({ label: t('getFileId'), action: 'get-file-id' });
      items.push({ label: t('copy'), action: 'copy' });
      items.push({ label: t('reply'), action: 'reply' });

      showContextMenu(e.clientX, e.clientY, items, (action) => {
        if (action === 'get-file-id' && fileRef) {
          if (fileRef.fileId && navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(fileRef.fileId).then(() => {}).catch(() => {});
          }
          return;
        }
        if (action === 'copy') {
          if (navigator.clipboard?.writeText) {
            const text = msg.content != null ? String(msg.content) : '';
            navigator.clipboard.writeText(text).then(() => {}).catch(() => {});
          }
          return;
        }
        if (action === 'recall') {
          if (confirm('Are you sure you want to recall this message?')) state.socket?.emit('message:recall', msgId, () => {});
        } else if (action === 'edit') startInlineEdit(msg);
        else if (action === 'delete') {
          if (confirm('Are you sure you want to delete this message?')) state.socket?.emit('message:delete', msgId, () => {});
        }
        if (action === 'remove-account') removeAccount(senderId);
        if (action === 'solve') {
          state.supportMessageIdForSolve = msgId;
          navigateTo('/chat/group/?panel=problem');
        }
        if (action === 'reply') setState({ replyTo: msg });
      });
    });
  }

  wrap?.addEventListener('click', (e) => {
    const videoEl = e.target.closest('.message-file-video');
    if (videoEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openMediaPopup(videoEl.dataset.msgId, videoEl.dataset.url, 'video', videoEl.dataset.prevMediaId || null, videoEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const imageEl = e.target.closest('.message-file-image');
    if (imageEl && !e.target.closest('a')) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      openMediaPopup(imageEl.dataset.msgId, imageEl.dataset.url, 'image', imageEl.dataset.prevMediaId || null, imageEl.dataset.nextMediaId || null, roomType, roomId);
      return;
    }
    const otherIcon = e.target.closest('.message-file-other-icon');
    if (otherIcon) {
      e.preventDefault();
      e.stopPropagation();
      const url = otherIcon.closest('.message-file-other')?.dataset?.url;
      if (url) openFileContentModal(url);
      return;
    }
    const likeBtn = e.target.closest('.message-like-btn');
    if (likeBtn) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = likeBtn.dataset.msgId;
      state.socket?.emit('message:like', msgId, () => {});
      return;
    }
    const saveBtn = e.target.closest('.message-edit-save');
    if (saveBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (saveBtn.disabled) return;
      const msgId = saveBtn.dataset.msgId;
      const textarea = document.querySelector(`.message-edit-input[data-msg-id="${msgId}"]`);
      const newContent = textarea?.value?.trim() ?? '';
      if (!newContent) return;
      state.socket?.emit('message:edit', { id: msgId, content: newContent }, () => {});
      setState({ editingMessageId: null });
      return;
    }
    const cancelBtn = e.target.closest('.message-edit-cancel');
    if (cancelBtn) {
      e.preventDefault();
      e.stopPropagation();
      setState({ editingMessageId: null });
      return;
    }
    const historyBtn = e.target.closest('.message-edit-history-btn');
    if (historyBtn && !historyBtn.disabled) {
      e.preventDefault();
      e.stopPropagation();
      const msgId = historyBtn.dataset.msgId;
      const dir = historyBtn.dataset.dir;
      const list = state.messages[roomKey(roomType, roomId)] || [];
      const msg = list.find(m => m.id === msgId);
      if (!msg) return;
      const versions = [...(msg.edit_history || []).map(h => h.content), msg.content || ''];
      const current = state.messageVersionIndex[msgId] ?? versions.length - 1;
      const next = dir === 'prev' ? Math.max(0, current - 1) : Math.min(versions.length - 1, current + 1);
      setState({ messageVersionIndex: { ...state.messageVersionIndex, [msgId]: next } });
    }
  });

  wrap?.addEventListener('loadedmetadata', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const totalSpan = el.closest('.message-file-audio')?.querySelector('.message-file-audio-total');
      if (totalSpan) totalSpan.textContent = formatAudioTime(el.duration);
    }
  });
  wrap?.addEventListener('timeupdate', (e) => {
    if (e.target.classList?.contains('message-file-audio-el')) {
      const el = e.target;
      const block = el.closest('.message-file-audio');
      const currentSpan = block?.querySelector('.message-file-audio-current');
      const progress = block?.querySelector('.message-file-audio-progress');
      if (currentSpan) currentSpan.textContent = formatAudioTime(el.currentTime);
      if (progress && Number.isFinite(el.duration)) progress.value = (el.currentTime / el.duration) * 100;
    }
  });
  wrap?.addEventListener('input', (e) => {
    if (e.target.classList?.contains('message-file-audio-progress')) {
      const range = e.target;
      const block = range.closest('.message-file-audio');
      const audio = block?.querySelector('.message-file-audio-el');
      if (audio && Number.isFinite(audio.duration)) audio.currentTime = (Number(range.value) / 100) * audio.duration;
    }
  });

  if (state.editingMessageId) {
    requestAnimationFrame(() => {
      const ta = document.querySelector(`.message-edit-input[data-msg-id="${state.editingMessageId}"]`);
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        const saveBtn = ta.closest('.message-edit-area')?.querySelector('.message-edit-save');
        const updateSaveState = () => {
          if (!saveBtn) return;
          const hasContent = ta.value.trim().length > 0;
          saveBtn.disabled = !hasContent;
        };
        updateSaveState();
        ta.addEventListener('input', updateSaveState);
        const onKey = (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
            ta.removeEventListener('input', updateSaveState);
          } else if (e.key === 'Enter' && !e.shiftKey) {
            const newContent = ta.value.trim();
            if (!newContent) {
              e.preventDefault();
              return;
            }
            e.preventDefault();
            state.socket?.emit('message:edit', { id: state.editingMessageId, content: newContent }, () => {});
            setState({ editingMessageId: null });
            ta.removeEventListener('keydown', onKey);
            ta.removeEventListener('input', updateSaveState);
          }
        };
        ta.addEventListener('keydown', onKey);
      }
    });
  }

  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('composer-input');
  const COMPOSER_MAX_HEIGHT = 200;
  function resizeComposerInput() {
    if (!input) return;
    input.style.height = '0';
    const h = Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT);
    input.style.height = Math.max(22, h) + 'px';
  }
  if (sendBtn && input) {
    const send = () => {
      if (state._sendingMessage) return;
      const text = input.value.trim();
      if (!text && !state._pendingFile) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;

      if (roomType === 'group' && state.commandMode && text.startsWith('/')) {
        const cmd = text.split(/\s/)[0].toLowerCase();
        if (cmd === '/games') {
          window.open('https://jimmyqrg.github.io/page');
          input.value = '';
          resizeComposerInput();
          return;
        }
        if (cmd === '/wordle') {
          showWordleModal();
          input.value = '';
          resizeComposerInput();
          return;
        }
        if (cmd === '/request-admin') {
          apiPost('/api/inbox/request-admin').then(() => {
            input.value = '';
            resizeComposerInput();
          }).catch((err) => showToast(err.message || 'Request failed'));
          return;
        }
        if (cmd === '/file') {
          const fileId = text.slice(5).trimStart();
          if (!fileId) {
            showToast('Usage: /file <file_id>');
            return;
          }
          state._sendingMessage = true;
      const reply_to_id = state.replyTo?.id || null;
            state.socket?.emit('message:send', { roomType, roomId, content: `/file ${fileId}`, msg_type: 'file', reply_to_id }, (res) => {
            state._sendingMessage = false;
            if (res?.error) { showToast(res.error); return; }
            if (res?.message) addMessageLocal(res.message);
            setState({ replyTo: null });
            input.value = '';
            resizeComposerInput();
          });
          return;
        }
      }

      const reply_to_id = state.replyTo?.id || null;
      if (state._spamBlockedUntil && Date.now() < state._spamBlockedUntil) {
        showToast('NO SPAMMING!');
        return;
      }
      const contentToCheck = text || '';
      const mentionedDeleted = roomType === 'group' ? getMentionedDeletedUsers(contentToCheck) : [];
      if (mentionedDeleted.length) {
        showToast(t('mentionDeletedUsers') + mentionedDeleted.join(', '));
      }

      state._sendingMessage = true;
      const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
      const done = () => { state._sendingMessage = false; };
      if (state._pendingFile) {
        if (!canSendFiles) {
          showToast('Add as friend to send files');
          state._pendingFile = null;
          render();
          state._sendingMessage = false;
          return;
        }
        const form = new FormData();
        form.append('file', state._pendingFile);
        form.append('content', text);
        form.append('msg_type', state._pendingFile.type.startsWith('image/') ? 'image' : state._pendingFile.type.startsWith('video/') ? 'video' : state._pendingFile.type.startsWith('audio/') ? 'audio' : 'file');
        if (reply_to_id) form.append('reply_to_id', reply_to_id);
        const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
        fetch(path, { method: 'POST', credentials: 'include', body: form })
          .then((r) => r.json())
          .then((data) => {
            if (data?.error) {
              showToast(data.error);
              if (data.error === 'NO SPAMMING!') {
                state._spamBlockedUntil = Date.now() + 5000;
                setState({});
                setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
              }
            }
            if (data?.message) addMessageLocal(data.message);
          state._pendingFile = null;
          setState({ replyTo: null });
          input.value = '';
            resizeComposerInput();
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
          })
          .catch(console.error)
          .finally(done);
        return;
      }
      state.socket?.emit('message:send', { roomType, roomId, content: text, reply_to_id }, (res) => {
        done();
        if (res?.error) {
          showToast(res.error);
          if (res.error === 'NO SPAMMING!') {
            state._spamBlockedUntil = Date.now() + 5000;
            setState({});
            setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
          }
          return;
        }
        if (res?.message) addMessageLocal(res.message);
        setState({ replyTo: null });
        input.value = '';
        resizeComposerInput();
      });
    };
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (isMobile()) return;
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('input', resizeComposerInput);
    requestAnimationFrame(resizeComposerInput);
  }

  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-file');
  const canSendFiles = document.getElementById('composer-drop-zone')?.dataset.canSendFiles !== 'false';
  if (fileInput) fileInput.disabled = !canSendFiles;
  if (attachBtn) {
    attachBtn.disabled = !canSendFiles;
    attachBtn.title = canSendFiles ? 'Attach file' : 'Add as friend to send files';
  }
  document.getElementById('attach-file')?.addEventListener('click', () => {
    if (!canSendFiles) {
      showToast('Add as friend to send files');
      return;
    }
    document.getElementById('file-input')?.click();
  });
  document.getElementById('file-input')?.addEventListener('change', (e) => {
    if (!canSendFiles) return;
    const file = e.target.files?.[0];
    if (file) {
      state._pendingFile = file;
      render();
    }
    e.target.value = '';
  });
  document.getElementById('clear-pending-file')?.addEventListener('click', () => {
    state._pendingFile = null;
    render();
  });

  if (!window._commandModeDelegated) {
    window._commandModeDelegated = true;
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#composer-command-mode');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      state.commandMode = !state.commandMode;
      try { localStorage.setItem('commandMode', state.commandMode ? '1' : '0'); } catch (_) {}
      btn.classList.toggle('composer-command-btn-on', state.commandMode);
      btn.setAttribute('aria-pressed', state.commandMode);
      btn.title = state.commandMode ? 'Command mode on (e.g. /games, /wordle, /file <id>)' : 'Command mode off (send as text)';
    });
  }
  document.getElementById('composer-mic')?.addEventListener('click', async () => {
    if (state._recording) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state._recordingStream = stream;
      state._recordingChunks = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size) state._recordingChunks.push(e.data); };
      recorder.start();
      state._recordingRecorder = recorder;
      setState({ _recording: true });
    } catch (err) {
      console.error('Microphone access failed', err);
    }
  });

  function stopRecording(discard = true) {
    if (state._recordingKeydownHandler) {
      document.removeEventListener('keydown', state._recordingKeydownHandler);
      state._recordingKeydownHandler = null;
    }
    if (state._recordingRecorder && state._recordingRecorder.state !== 'inactive') {
      state._recordingRecorder.stop();
    }
    if (state._recordingStream) {
      state._recordingStream.getTracks().forEach((t) => t.stop());
    }
    state._recording = false;
    state._recordingStream = null;
    state._recordingRecorder = null;
    const chunks = state._recordingChunks || [];
    state._recordingChunks = [];
    setState({});
    return discard ? null : chunks;
  }

  document.getElementById('recording-send')?.addEventListener('click', () => {
    const chunks = stopRecording(false);
    if (!chunks || chunks.length === 0) return;
    const roomType = state.dmUserId ? 'dm' : 'group';
    const roomId = state.dmUserId ? state.convId : state.panel;
    const reply_to_id = state.replyTo?.id || null;
    const canSendFiles = roomType === 'dm' ? isFriend(state.dmUserId) : true;
    if (!canSendFiles) return;
    const blob = new Blob(chunks, { type: 'audio/webm' });
    const file = new File([blob], 'voice.webm', { type: 'audio/webm' });
    const form = new FormData();
    form.append('file', file);
    form.append('content', '');
    form.append('msg_type', 'voice');
    if (reply_to_id) form.append('reply_to_id', reply_to_id);
    const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
    fetch(path, { method: 'POST', credentials: 'include', body: form }).then((r) => r.json()).then((data) => {
      if (data?.error) {
        showToast(data.error);
        if (data.error === 'NO SPAMMING!') {
          state._spamBlockedUntil = Date.now() + 5000;
          setState({});
          setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
        }
      }
      if (data.message) addMessageLocal(data.message);
      setState({ replyTo: null });
      if (roomType === 'dm') loadMessages('dm', roomId).then(render);
    }).catch(console.error);
  });

  document.getElementById('recording-cancel')?.addEventListener('click', () => {
    stopRecording(true);
  });

  const recordingOverlay = document.getElementById('recording-overlay');
  if (recordingOverlay && !state._recordingKeydownHandler) {
    const keydown = (e) => {
      if (!state._recording) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        stopRecording(true);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('recording-send')?.click();
      }
    };
    state._recordingKeydownHandler = keydown;
    document.addEventListener('keydown', keydown);
  }

  const dropZone = document.getElementById('composer-drop-zone');
  if (dropZone) {
    ['dragenter', 'dragover'].forEach((ev) => {
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files') && canSendFiles) dropZone.classList.add('composer-drag-over');
      });
    });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('composer-drag-over');
    });
    dropZone.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file') {
          if (!canSendFiles) {
            e.preventDefault();
            showToast('Add as friend to send files');
            return;
          }
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            e.stopPropagation();
            state._pendingFile = file;
            render();
          }
          break;
        }
      }
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('composer-drag-over');
      if (!canSendFiles) {
        showToast('Add as friend to send files');
        return;
      }
      const file = e.dataTransfer.files?.[0];
      if (!file) return;
      const roomType = state.dmUserId ? 'dm' : 'group';
      const roomId = state.dmUserId ? state.convId : state.panel;
      const reply_to_id = state.replyTo?.id || null;
      const msgType = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
      const form = new FormData();
      form.append('file', file);
      form.append('content', '');
      form.append('msg_type', msgType);
      if (reply_to_id) form.append('reply_to_id', reply_to_id);
      const path = roomType === 'dm' ? `/api/conversations/${roomId}/messages` : `/api/rooms/${roomType}/${roomId}/messages`;
      state._sendingMessage = true;
      fetch(path, { method: 'POST', credentials: 'include', body: form })
        .then((r) => r.json())
        .then((data) => {
          if (data?.error) {
            showToast(data.error);
            if (data.error === 'NO SPAMMING!') {
              state._spamBlockedUntil = Date.now() + 5000;
              setState({});
              setTimeout(() => { state._spamBlockedUntil = null; setState({}); }, 5000);
            }
          }
          if (data?.message) addMessageLocal(data.message);
          setState({ replyTo: null });
          if (roomType === 'dm') loadMessages('dm', roomId).then(render);
        })
        .catch(console.error)
        .finally(() => { state._sendingMessage = false; });
    });
  }

  const saveDocBtn = document.getElementById('save-doc');
  const docContent = document.getElementById('doc-content');
  const docSupportId = document.getElementById('doc-support-msg-id');
  if (saveDocBtn && docContent) {
    saveDocBtn.addEventListener('click', async () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (!docKey) return;
      const content = docContent.value;
      const support_message_id = docSupportId?.value || null;
      try {
        await saveDoc(docKey, content, support_message_id || undefined);
        state.supportMessageIdForSolve = null;
        const { doc: fresh } = await loadDoc(docKey);
        state._docContent = fresh?.content ?? content;
        state.editingDocKey = null;
        setState({});
      } catch (e) {
        showToast(e.message);
      }
    });
  }

  const cancelDocEdit = document.getElementById('cancel-doc-edit');
  if (cancelDocEdit) {
    cancelDocEdit.addEventListener('click', () => {
      state.editingDocKey = null;
      setState({});
    });
  }

  const startDocEdit = document.getElementById('start-doc-edit');
  if (startDocEdit) {
    startDocEdit.addEventListener('click', () => {
      const docKey = document.querySelector('.doc-panel')?.dataset.docKey;
      if (docKey) {
        state.editingDocKey = docKey;
        setState({});
      }
    });
  }

  if (state._docContent !== undefined && docContent && !docContent.value) docContent.value = state._docContent;
}

function showContextMenu(x, y, items, onSelect) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  items.forEach(({ label, action, danger }) => {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (danger) btn.classList.add('danger');
    btn.addEventListener('click', () => { onSelect(action); menu.remove(); });
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function startInlineEdit(msg) {
  setState({ editingMessageId: msg.id });
}

async function removeAccount(userId) {
  if (!confirm(t('adminRemoveAccountConfirm'))) return;
  try {
    await apiPost('/api/admin/remove-account', { user_id: userId });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

async function restoreAccount(userId) {
  try {
    await apiPost('/api/admin/restore-account', { user_id: userId });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

function showDeletePermanentlyModal(userId) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay profile-modal-overlay';
  overlay.innerHTML = `
    <div class="modal profile-modal admin-delete-modal">
      <button type="button" class="profile-modal-close" aria-label="Close">&times;</button>
      <h3>${t('adminDeleteAccountTitle')}</h3>
      <p>${t('adminDeleteAccountDesc')}</p>
      <label class="admin-delete-msgs-label"><input type="checkbox" id="admin-delete-msgs-cb" checked /> ${t('adminDeleteGroupMessages')}</label>
      <div class="admin-delete-modal-actions">
        <button type="button" class="btn-small" id="admin-delete-cancel">${t('cancel')}</button>
        <button type="button" class="btn-small btn-danger" id="admin-delete-confirm">${t('adminDeletePermanently')}</button>
      </div>
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.closest('.profile-modal-close') || e.target.id === 'admin-delete-cancel') overlay.remove();
  });
  overlay.querySelector('#admin-delete-confirm')?.addEventListener('click', async () => {
    const cb = overlay.querySelector('#admin-delete-msgs-cb');
    overlay.remove();
    try {
      await apiPost('/api/admin/delete-account-permanently', { user_id: userId, delete_group_messages: cb?.checked !== false });
      await loadUsers();
      render();
      bindAdmin();
    } catch (err) { showToast(err.message); }
  });
  document.body.appendChild(overlay);
}

async function deleteAccountPermanently(userId, deleteGroupMessages = true) {
  try {
    await apiPost('/api/admin/delete-account-permanently', { user_id: userId, delete_group_messages: deleteGroupMessages });
    await loadUsers();
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

async function toggleBlacklist(userId, isBlacklisted) {
  try {
    if (isBlacklisted) {
      await apiDelete(`/api/admin/blacklist/${userId}`);
    } else {
      await apiPost('/api/admin/blacklist', { user_id: userId });
    }
    state.adminBlacklistedIds = isBlacklisted
      ? (state.adminBlacklistedIds || []).filter(id => id !== userId)
      : [...(state.adminBlacklistedIds || []), userId];
    render();
    bindAdmin();
  } catch (err) { showToast(err.message); }
}

function renderAdminContent() {
  const adminTab = new URLSearchParams(window.location.search || '').get('tab') || 'action';
  const users = state.users || [];
  const otherUsers = users.filter(u => u.id !== state.user?.id);
  return `
        <div class="admin-main">
          ${adminTab === 'action' ? `
          ${state.user?.can_send_inbox ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminSendToInbox')}</h2>
            <p class="admin-section-desc">${t('adminSendToInboxDesc')}</p>
            <div class="admin-form">
              <label>${t('users')}</label>
        <select id="admin-inbox-user">
                <option value="">${t('adminSelectUser')}</option>
                ${otherUsers.map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
        </select>
              <label>${t('adminTitle')}</label>
              <input type="text" id="admin-inbox-title" placeholder="${t('adminTitle')}" />
              <label>${t('adminBody')}</label>
              <textarea id="admin-inbox-body" placeholder="${t('adminMessageBody')}" rows="4"></textarea>
              <button type="button" id="admin-inbox-send" class="btn-primary">${t('send')}</button>
      </div>
      </div>
          ` : ''}
          ${state.user?.can_broadcast ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminBroadcast')}</h2>
            <p class="admin-section-desc">${t('adminBroadcastDesc')}</p>
            <div class="admin-form">
              <label>${t('adminTitle')}</label>
              <input type="text" id="admin-broadcast-title" placeholder="${t('adminTitle')}" />
              <label>${t('adminBody')}</label>
              <textarea id="admin-broadcast-body" placeholder="${t('adminMessageBody')}" rows="4"></textarea>
              <button type="button" id="admin-broadcast-send" class="btn-primary">${t('adminPermBroadcast')}</button>
      </div>
          </div>
          ` : ''}
          ${state.user?.can_timeout ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminTimeoutUser')}</h2>
            <p class="admin-section-desc">${t('adminTimeoutDurationDesc')}</p>
            <div class="admin-form">
              <label>${t('users')}</label>
              <select id="admin-timeout-user">
                <option value="">${t('adminSelectUser')}</option>
                ${otherUsers.filter(u => u.id !== 'jimmyqrg').map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
              </select>
              <label>${t('adminDuration')}</label>
              <input type="text" id="admin-timeout-duration" placeholder="${t('adminDurationPlaceholder')}" />
              ${state.user?.id === 'jimmyqrg' ? `<label class="admin-timeout-locked"><input type="checkbox" id="admin-timeout-locked" /> ${t('adminOnlyICanRelease')}</label>` : ''}
              <button type="button" id="admin-timeout-submit" class="btn-primary">${t('adminPermTimeout')}</button>
            </div>
            <div id="admin-timeout-list" class="admin-timeout-list"></div>
          </div>
          ` : ''}
          ${!state.user?.can_send_inbox && !state.user?.can_broadcast && !state.user?.can_timeout ? `<p class="admin-section-desc">${t('adminNoPermissions')}</p>` : ''}
          ` : ''}
          ${adminTab === 'recalled' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminRecalledMessages')}</h2>
            <p class="admin-section-desc">${t('adminRecalledDesc')}</p>
            <div id="admin-recalled-list" class="admin-recalled-list"></div>
          </div>
          ` : ''}
          ${adminTab === 'timeout' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminTimeoutUser')}</h2>
            <p class="admin-section-desc">${t('adminTimeoutUserDesc')}</p>
            <div class="admin-form">
              <label>${t('users')}</label>
              <select id="admin-timeout-user-tab">
                <option value="">${t('adminSelectUser')}</option>
                ${otherUsers.filter(u => u.id !== 'jimmyqrg').map(u => `<option value="${u.id}">${escapeHtml(u.display_name || u.username)}</option>`).join('')}
              </select>
              <label>${t('adminDuration')}</label>
              <input type="text" id="admin-timeout-duration-tab" placeholder="${t('adminDurationPlaceholder')}" />
              ${state.user?.id === 'jimmyqrg' ? `<label class="admin-timeout-locked"><input type="checkbox" id="admin-timeout-locked-tab" /> ${t('adminOnlyICanRelease')}</label>` : ''}
              <button type="button" id="admin-timeout-submit-tab" class="btn-primary">${t('adminPermTimeout')}</button>
            </div>
            <div id="admin-timeout-list-tab" class="admin-timeout-list"></div>
          </div>
          ` : ''}
          ${adminTab === 'users' ? `
          <div class="admin-section">
            <h2 class="admin-section-title">${t('adminUsersSection')}</h2>
            <p class="admin-section-desc">${t('adminUsersDesc')}</p>
            <div class="admin-users-list" id="admin-user-list">
              ${users.map(u => {
                const canManage = state.user?.can_manage_users;
                const permLabels = { can_send_inbox: t('adminPermSendMail'), can_broadcast: t('adminPermBroadcast'), can_edit_docs: t('adminPermEditDocs'), can_kick: t('adminPermRemoveAccount'), can_delete_messages: t('adminPermDeleteMessages'), can_manage_users: t('adminPermManageUsers'), can_timeout: t('adminPermTimeout') };
                const permKeys = ['can_send_inbox', 'can_broadcast', 'can_edit_docs', 'can_kick', 'can_delete_messages', 'can_manage_users', 'can_timeout'];
                const isAdmin = u.id === 'jimmyqrg';
                const showPerms = canManage && !isAdmin && u.is_allowed;
                const defAvU = getDefaultAvatarUrl(u.id);
                const avSrcU = (u.avatar_url && String(u.avatar_url).trim()) ? u.avatar_url : defAvU;
                return `
                <div class="admin-user-card" data-user-id="${u.id}">
                  <img src="${avSrcU}" data-fallback="${defAvU.replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="admin-user-avatar" />
                  <div class="admin-user-info">
                    <span class="admin-user-name">${escapeHtml(u.display_name || u.username)}</span>
                    <span class="admin-user-meta">${isAdmin ? t('adminRoleAdmin') : u.deleted_at ? t('adminRoleDeleted') : (u.is_allowed ? t('adminRoleOnList') : t('adminRoleMember'))}</span>
                  </div>
                  ${!isAdmin ? `
                  <div class="admin-user-actions">
                    ${canManage ? `<button type="button" class="btn-small" data-action="allowed" data-user-id="${u.id}" data-allowed="${u.is_allowed ? '1' : '0'}">${u.is_allowed ? t('adminRemoveFromList') : t('adminAddToList')}</button>` : ''}
                    ${state.user?.can_kick ? (u.deleted_at
                      ? `<button type="button" class="btn-small" data-action="restore" data-user-id="${u.id}">${t('adminRestore')}</button>
                         ${state.user?.id === 'jimmyqrg' ? `<button type="button" class="btn-small btn-danger" data-action="delete-permanently" data-user-id="${u.id}">${t('adminDeletePermanently')}</button>` : ''}`
                      : `<button type="button" class="btn-small btn-danger" data-action="remove-account" data-user-id="${u.id}">${t('adminRemoveAccount')}</button>
                         <button type="button" class="btn-small" data-action="blacklist" data-user-id="${u.id}" data-blacklisted="${(state.adminBlacklistedIds || []).includes(u.id) ? '1' : '0'}">${(state.adminBlacklistedIds || []).includes(u.id) ? t('adminUnblacklist') : t('adminBlacklist')}</button>`) : ''}
                  </div>
                  ${showPerms ? `
                  <div class="admin-user-perms">
                    ${permKeys.map(k => `<label class="admin-perm-check"><input type="checkbox" data-action="perm" data-user-id="${u.id}" data-perm="${k}" ${u[k] ? 'checked' : ''} /> ${escapeHtml(permLabels[k])}</label>`).join('')}
                  </div>
                  ` : ''}
                  ` : ''}
                </div>
              `}).join('')}
            </div>
          </div>
          ` : ''}
    </div>
  `;
}

async function loadAdminRecalled() {
  const el = document.getElementById('admin-recalled-list');
  if (!el) return;
  try {
    const { messages } = await apiGet('/api/admin/recalled-messages');
    el.innerHTML = messages.length === 0
      ? `<p class="admin-section-desc">${t('adminNoRecalledMessages')}</p>`
      : `<ul class="admin-recalled-ul">${messages.map(m => `
        <li class="admin-recalled-item">
          <strong>${escapeHtml(m.display_name || m.username || 'Unknown user')}</strong>
          <span class="admin-recalled-time">${formatTime(m.recalled_at)}</span>
          <p class="admin-recalled-content">${escapeHtml((m.content || '').slice(0, 200))}</p>
        </li>
      `).join('')}</ul>`;
  } catch (err) {
    el.innerHTML = `<p class="admin-section-desc">${t('adminFailedToLoad')}</p>`;
  }
}

async function loadAdminBlacklist() {
  if (!state.user?.can_kick) return;
  try {
    const { blacklisted_ids } = await apiGet('/api/admin/blacklist');
    state.adminBlacklistedIds = blacklisted_ids || [];
  } catch (_) { state.adminBlacklistedIds = []; }
}

async function loadAdminTimeouts() {
  const el = document.getElementById('admin-timeout-list');
  const elTab = document.getElementById('admin-timeout-list-tab');
  const listEl = el || elTab;
  if (!listEl) return;
  try {
    const { timeouts } = await apiGet('/api/admin/timeouts');
    const html = timeouts.length === 0
      ? `<p class="admin-section-desc">${t('adminNoActiveTimeouts')}</p>`
      : `<ul class="admin-timeout-ul">${timeouts.map(to => `
        <li class="admin-timeout-item">
          <span>${escapeHtml(to.display_name || to.username)}</span>
          <span class="admin-timeout-meta">${to.expires_at ? t('adminTimeoutUntil') + formatTime(to.expires_at) : t('adminTimeoutForever')} ${to.locked_release ? t('adminTimeoutLocked') : ''}</span>
          ${(!to.locked_release || state.user?.id === 'jimmyqrg') ? `<button type="button" class="btn-small admin-timeout-release" data-timeout-id="${to.id}">${t('adminRelease')}</button>` : ''}
        </li>
      `).join('')}</ul>`;
    if (el) el.innerHTML = html;
    if (elTab) elTab.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = `<p class="admin-section-desc">${t('adminFailedToLoad')}</p>`;
  }
}

function bindAdmin() {
  const loadingHtml = `<p class="admin-section-desc admin-loading"><span class="admin-loading-spinner" aria-hidden="true"></span> ${t('loading')}</p>`;
  const recalledEl = document.getElementById('admin-recalled-list');
  const timeoutEl = document.getElementById('admin-timeout-list');
  const timeoutElTab = document.getElementById('admin-timeout-list-tab');
  if (recalledEl) recalledEl.innerHTML = loadingHtml;
  if (timeoutEl) timeoutEl.innerHTML = loadingHtml;
  if (timeoutElTab) timeoutElTab.innerHTML = loadingHtml;
  loadAdminRecalled();
  loadAdminTimeouts();

  document.getElementById('admin-timeout-submit')?.addEventListener('click', async () => {
    const userId = document.getElementById('admin-timeout-user')?.value;
    const duration = document.getElementById('admin-timeout-duration')?.value?.trim();
    const locked = document.getElementById('admin-timeout-locked')?.checked;
    if (!userId) { showToast(t('adminSelectUser')); return; }
    try {
      await apiPost('/api/admin/timeout', { user_id: userId, duration: duration || 'forever', locked_release: !!locked });
      document.getElementById('admin-timeout-duration').value = '';
      loadAdminTimeouts();
    } catch (err) { showToast(err.message); }
  });
  document.getElementById('admin-timeout-submit-tab')?.addEventListener('click', async () => {
    const userId = document.getElementById('admin-timeout-user-tab')?.value;
    const duration = document.getElementById('admin-timeout-duration-tab')?.value?.trim();
    const locked = document.getElementById('admin-timeout-locked-tab')?.checked;
    if (!userId) { showToast(t('adminSelectUser')); return; }
    try {
      await apiPost('/api/admin/timeout', { user_id: userId, duration: duration || 'forever', locked_release: !!locked });
      document.getElementById('admin-timeout-duration-tab').value = '';
      loadAdminTimeouts();
    } catch (err) { showToast(err.message); }
  });

  document.querySelector('.admin-timeout-list')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { showToast(err.message); }
    }
  });
  document.getElementById('admin-timeout-list-tab')?.closest('.admin-section')?.addEventListener('click', async (e) => {
    const releaseBtn = e.target.closest('.admin-timeout-release');
    if (releaseBtn) {
      const id = releaseBtn.dataset.timeoutId;
      try {
        await apiPost(`/api/admin/timeout/${id}/release`, {});
        loadAdminTimeouts();
      } catch (err) { showToast(err.message); }
    }
  });

  document.getElementById('admin-user-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (btn) {
    const userId = btn.dataset.userId;
      if (btn.dataset.action === 'remove-account') removeAccount(userId);
      if (btn.dataset.action === 'restore') restoreAccount(userId);
      if (btn.dataset.action === 'delete-permanently') showDeletePermanentlyModal(userId);
      if (btn.dataset.action === 'blacklist') toggleBlacklist(userId, btn.dataset.blacklisted === '1');
    if (btn.dataset.action === 'allowed') {
      const allowed = btn.dataset.allowed !== '1';
      try {
        await apiPost('/api/admin/users/' + userId + '/allowed', { allowed });
        await loadUsers();
          render();
          bindAdmin();
      } catch (err) { showToast(err.message); }
      }
    }
  });
  document.getElementById('admin-user-list')?.addEventListener('change', async (e) => {
    const cb = e.target.closest('input[data-action="perm"]');
    if (!cb) return;
    const userId = cb.dataset.userId;
    const perm = cb.dataset.perm;
    const value = !!cb.checked;
    try {
      await apiPatch('/api/admin/users/' + userId + '/permissions', { [perm]: value });
      await loadUsers();
      render();
      bindAdmin();
    } catch (err) { showToast(err.message); }
  });
  document.getElementById('admin-inbox-send')?.addEventListener('click', async () => {
    const to = document.getElementById('admin-inbox-user')?.value;
    const title = document.getElementById('admin-inbox-title')?.value ?? '';
    const body = document.getElementById('admin-inbox-body')?.value ?? '';
    if (!to) { showToast(t('adminSelectUser')); return; }
    try {
      await apiPost('/api/inbox/send', { to_user_id: to, title, body });
      showToast(t('adminSent'), 'success');
    } catch (e) { showToast(e.message); }
  });
  document.getElementById('admin-broadcast-send')?.addEventListener('click', async () => {
    const title = document.getElementById('admin-broadcast-title')?.value ?? '';
    const body = document.getElementById('admin-broadcast-body')?.value ?? '';
    try {
      await apiPost('/api/inbox/broadcast', { title, body });
      showToast(t('adminBroadcastSent'), 'success');
    } catch (e) { showToast(e.message); }
  });
}

function renderSettingsPage() {
  return `<div class="settings-page-wrap">${renderSettingsContent()}</div>`;
}

const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
];

function renderSettingsContent() {
  const tab = new URLSearchParams(window.location.search || '').get('tab') || 'profile';
  return `
        <div class="settings-page">
      ${tab === 'general' ? `
      <div class="settings-general">
        <h3 class="settings-section-title">${t('theme')}</h3>
        <p class="settings-account-desc">${t('chooseTheme')}</p>
        <label class="settings-form-label">${t('theme')}</label>
        <select id="settings-theme" class="settings-select">
          <option value="jimmyqrg" ${state.theme === 'jimmyqrg' ? 'selected' : ''}>JimmyQrg</option>
          <option value="simple" ${state.theme === 'simple' ? 'selected' : ''}>Simple</option>
          <option value="comic" ${state.theme === 'comic' ? 'selected' : ''}>Comic</option>
        </select>
        <h3 class="settings-section-title">${t('systemLanguage')}</h3>
        <p class="settings-account-desc">${t('chooseLanguage')}</p>
        <label class="settings-form-label">${t('language')}</label>
        <select id="settings-language" class="settings-select">
          ${(state.languageOptions || LANGUAGE_OPTIONS).map(o => `<option value="${o.value}" ${state.language === o.value ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
        </select>
          </div>
      ` : ''}
      ${tab === 'profile' ? `
          <form id="profile-form" class="settings-form">
        <label>${t('avatar')}</label>
        <div class="settings-avatar-drop-zone" id="settings-avatar-drop-zone">
          <img src="${state._pendingAvatarObjectUrl || getCurrentUserAvatarUrl()}" data-fallback="${getDefaultAvatarUrl(state.user?.id).replace(/"/g, '&quot;')}" onerror="this.onerror=null;if(this.dataset.fallback)this.src=this.dataset.fallback" alt="" class="avatar-preview" id="avatar-preview" />
          <span class="settings-avatar-drop-hint">${t('dropImage')}</span>
        </div>
        <label class="file-label">
          <span class="file-label-text">${t('chooseImage')}</span>
          <input type="file" name="avatar" accept="image/*" class="file-input" />
        </label>
        <label>${t('displayName')}</label>
            <input type="text" name="display_name" value="${escapeHtml(state.user?.display_name || '')}" />
        <label>${t('description')}</label>
        <textarea name="description" rows="3" placeholder="${t('descriptionPlaceholder')}">${escapeHtml(state.user?.description || '')}</textarea>
        <label>${t('website')}</label>
        <input type="url" name="website" placeholder="https://..." value="${escapeHtml(state.user?.website || '')}" />
        <button type="submit">${t('save')}</button>
          </form>
      ` : ''}
      ${tab === 'notifications' ? `
      <div class="settings-notifications">
        <h3 class="settings-section-title">${t('notifications')}</h3>
        <p class="settings-account-desc">${t('notificationsDesc')}</p>
        <div class="settings-form">
          <label class="settings-checkbox-label">
            <input type="checkbox" id="notif-enabled" ${state.notificationPrefs?.enabled ? 'checked' : ''} />
            <span>Enable desktop notifications</span>
          </label>
          <div id="notif-triggers" class="notif-triggers" style="${state.notificationPrefs?.enabled ? '' : 'opacity:0.5;pointer-events:none'}">
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-mails" ${state.notificationPrefs?.notify_mails !== false ? 'checked' : ''} /><span>${t('notifyMails')}</span></label>
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-dm" ${state.notificationPrefs?.notify_dm !== false ? 'checked' : ''} /><span>${t('notifyDm')}</span></label>
            <label class="settings-checkbox-label"><input type="checkbox" id="notif-group" ${state.notificationPrefs?.notify_group !== false ? 'checked' : ''} /><span>${t('notifyGroup')}</span></label>
        </div>
          <div id="notif-dnd" class="notif-dnd" style="${state.notificationPrefs?.enabled ? '' : 'opacity:0.5;pointer-events:none'}">
            <h4 class="settings-section-title">${t('doNotDisturb')}</h4>
            ${state.notificationPrefs?.dnd_until && Date.now() < state.notificationPrefs.dnd_until
              ? `<button type="button" id="notif-dnd-end-now" class="btn-small btn-danger">${t('dndEndNow')}</button>`
              : `<button type="button" id="notif-dnd-open" class="btn-secondary">${t('doNotDisturb')}</button>`}
            <label class="settings-checkbox-label" style="margin-top:0.5rem;display:block">
              <input type="checkbox" id="notif-dnd-at-night" ${state.notificationPrefs?.dnd_at_night ? 'checked' : ''} />
              <span>${t('dndAtNight')}</span>
            </label>
            ${state.notificationPrefs?.dnd_at_night ? `
            <div class="dnd-location-row" style="margin-top:0.5rem;display:flex;gap:0.5rem;flex-wrap:wrap">
              <button type="button" id="notif-dnd-use-location" class="btn-small">${t('dndUseLocation')}</button>
              <button type="button" id="notif-dnd-enter-city" class="btn-small">${t('dndEnterCity')}</button>
      </div>
            ` : ''}
          </div>
        </div>
      </div>
      ` : ''}
      ${tab === 'account' ? `
      <div class="settings-account">
        <div class="settings-account-block">
          <h3 class="settings-section-title">${t('password')}</h3>
          <p class="settings-account-desc">${t('changePasswordDesc')}</p>
          <button type="button" id="open-password-modal" class="btn-secondary">${t('changePassword')}</button>
        </div>
        <div class="settings-account-block">
          <h3 class="settings-section-title">${t('signOut')}</h3>
          <p class="settings-account-desc">${t('signOutDesc')}</p>
          <button type="button" id="sign-out-btn" class="btn-danger">${t('signOut')}</button>
        </div>
      </div>
      ` : ''}
    </div>
  `;
}

function renderInboxContent() {
  const loading = state._loadingInbox === true;
  const list = state.inbox || [];
  const empty = !loading && list.length === 0;
  return `
        <div class="inbox-page">
      <h2>${t('inbox')}</h2>
          <div id="inbox-list">
        ${loading
          ? `<div class="inbox-loading"><span class="inbox-loading-spinner" aria-hidden="true"></span><span>${t('loading')}</span></div>`
          : empty
          ? `<div class="inbox-empty"><span class="inbox-empty-icon" aria-hidden="true"><i class="fas fa-inbox"></i></span><span>${t('noMailYet')}</span></div>`
          : list.map(item => `
          <div class="inbox-item ${item.read_at ? '' : 'unread'}" data-id="${item.id}" data-type="${escapeHtml(item.type)}" data-related="${escapeHtml(item.related_id || '')}" data-extra="${escapeHtml(item.related_extra || '')}">
            <div class="inbox-item-main">
                <div class="type">${escapeHtml(item.type)}</div>
                <div class="title">${escapeHtml(item.title || '')}</div>
                <div class="body">${escapeHtml(item.body || '')}</div>
              ${item.type === 'friend_request' && !item.read_at ? `
              <div class="inbox-item-actions">
                <button type="button" class="btn-small btn-primary inbox-accept-fr" data-inbox-id="${item.id}">${t('accept')}</button>
                <button type="button" class="btn-small inbox-reject-fr" data-inbox-id="${item.id}">${t('reject')}</button>
              </div>
              ` : ''}
          </div>
            <button type="button" class="inbox-item-delete" data-inbox-id="${item.id}" title="${t('delete')}" aria-label="${t('delete')}"><i class="fas fa-trash-alt" aria-hidden="true"></i></button>
        </div>
        `).join('')}
      </div>
    </div>
  `;
}

function applyRoute(route) {
  if (state.user && (route.page === 'login' || route.page === 'signup')) {
    navigateTo('/chat/group/');
    return;
  }
  if (!state.user && (route.page === 'login' || route.page === 'signup')) {
    render();
    return;
  }
  if (route.page === 'settings') {
    setState({ panel: '', dmUserId: null });
    render();
    bindSettings();
    return;
  }
  if (route.page === 'inbox') {
    setState({ panel: '', dmUserId: null, _loadingInbox: true });
    render();
    loadInbox().then(() => { state._loadingInbox = false; setState({}); render(); bindInbox(); }).catch((err) => {
      console.warn('Load inbox failed', err);
      state._loadingInbox = false;
      setState({});
      render();
      bindInbox();
      showToast(err.message || 'Failed to load inbox');
    });
    return;
  }
  if (route.page === 'admin') {
    if (!state.user?.is_allowed) {
          navigateTo(getRedirectOrDefault());
      return;
    }
    setState({ panel: '', dmUserId: null });
    loadAdminBlacklist().then(() => {
      render();
      bindAdmin();
    });
    return;
  }
  if (route.page === 'chat') {
    state.panel = route.panel || 'free_chat';
    state.editingDocKey = null;
    state.dmUserId = route.dmUserId || null;
    state.convId = null;
    loadConversations().then(() => {
      if (route.section === 'dms') {
        setState({});
        render();
        return;
      }
    if (route.dmUserId) {
        if (route.view === 'profile') {
          state._profileView = { userId: route.dmUserId, profile: null, loading: true, error: null };
          render();
      apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
        state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            state.socket?.emit('dm:join', conversation_id, () => {});
            setState({});
          }).catch(() => { state.convId = null; });
          apiGet(`/api/users/${encodeURIComponent(route.dmUserId)}/profile`).then(({ profile }) => {
            state._profileView = { userId: route.dmUserId, profile, loading: false, error: null };
            setState({});
          }).catch((err) => {
            state._profileView = { userId: route.dmUserId, profile: null, loading: false, error: err.message || 'Could not load profile' };
            setState({});
          });
        } else {
          state._profileView = null;
          apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
            state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            return loadMessages('dm', conversation_id).then(() => {
          state.socket?.emit('dm:join', conversation_id, () => {});
          render();
            });
          }).catch((err) => {
            console.warn('Load conversation/messages failed', err);
            render();
          });
        }
      return;
    }
    state.convId = null;
    if (state.panel === 'free_chat' || state.panel === 'support') {
        loadMessages('group', state.panel).then(() => { render(); }).catch((err) => {
          console.warn('Load messages failed', err);
          render();
        });
      } else if (state.panel === 'problem_solving' || state.panel === 'rules' || state.panel === 'announcements') {
        const loadPanelDoc = () => loadDoc(state.panel).then(({ doc }) => {
        state._docContent = doc?.content ?? '';
        render();
      });
        if (state.panel === 'announcements') {
          apiPost('/api/docs/announcements/sync').then(() => loadPanelDoc(), () => loadPanelDoc());
    } else {
          loadPanelDoc().catch((err) => {
            console.warn('Load doc failed', err);
      render();
          });
        }
      } else {
        render();
      }
    }).catch((err) => {
      console.warn('Load conversations failed', err);
      if (route.section === 'dms') { setState({}); render(); return; }
      if (route.dmUserId) {
        if (route.view === 'profile') {
          state._profileView = { userId: route.dmUserId, profile: null, loading: true, error: null };
          render();
          apiGet(`/api/users/${encodeURIComponent(route.dmUserId)}/profile`).then(({ profile }) => {
            state._profileView = { userId: route.dmUserId, profile, loading: false, error: null };
            setState({});
          }).catch((err) => {
            state._profileView = { userId: route.dmUserId, profile: null, loading: false, error: err.message || 'Could not load profile' };
            setState({});
          });
        } else {
          state._profileView = null;
          apiGet(`/api/conversations/with/${route.dmUserId}`).then(({ conversation_id }) => {
            state.convId = conversation_id;
            state.convByUserId[route.dmUserId] = conversation_id;
            state.convIdToUserId[conversation_id] = route.dmUserId;
            return loadMessages('dm', conversation_id).then(() => { state.socket?.emit('dm:join', conversation_id, () => {}); render(); });
          }).catch(() => { render(); });
        }
      } else {
        render();
      }
    });
  }
}

async function init() {
  const loadingEl = document.querySelector('.loading-text');
  if (loadingEl) loadingEl.textContent = t('loading');

  window.addEventListener('popstate', () => applyRoute(parseRoute()));

  // Single delegated listener for in-app links (do not re-attach on every render)
  const appEl = document.getElementById('app');
  if (appEl) {
    interceptLinks(appEl);
    bindLinkPreview(appEl);
    // Delegated listeners for expand/toggle: update state + toggle class on existing DOM (no setState)
    // so first click works and CSS transition/animation run on the same element
    appEl.addEventListener('click', (e) => {
      const toggle = e.target.closest('#panel-column-toggle');
      const expand = e.target.closest('#left-bar-expand');
      const overlay = e.target.closest('#panel-column-overlay');
      if (toggle) {
        e.preventDefault();
        state.panelColumnExpanded = !state.panelColumnExpanded;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.toggle('panel-column-expanded', state.panelColumnExpanded);
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = state.panelColumnExpanded ? 'Close panels' : 'Open panels';
          btn.setAttribute('aria-label', btn.title);
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = state.panelColumnExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
        }
      } else if (expand) {
        e.preventDefault();
        state.leftBarExpanded = !state.leftBarExpanded;
        try { localStorage.setItem('leftBarExpanded', state.leftBarExpanded ? '1' : '0'); } catch (_) {}
        const bar = document.getElementById('left-bar');
        if (bar) bar.classList.toggle('left-bar-expanded', state.leftBarExpanded);
        const expandBtn = document.getElementById('left-bar-expand');
        if (expandBtn) {
          expandBtn.title = state.leftBarExpanded ? 'Collapse' : 'Expand';
          const icon = expandBtn.querySelector('.left-bar-icon');
          const label = expandBtn.querySelector('.left-bar-label');
          if (icon) icon.innerHTML = state.leftBarExpanded ? ICON_CHEVRON_LEFT : ICON_CHEVRON_RIGHT;
          if (label) label.textContent = state.leftBarExpanded ? 'Collapse' : 'Expand';
        }
      } else if (overlay) {
        e.preventDefault();
        state.panelColumnExpanded = false;
        const panel = document.getElementById('panel-column');
        if (panel) panel.classList.remove('panel-column-expanded');
        const btn = document.getElementById('panel-column-toggle');
        if (btn) {
          btn.title = 'Open panels';
          btn.setAttribute('aria-label', 'Open panels');
          const icon = btn.querySelector('.left-bar-icon');
          if (icon) icon.innerHTML = ICON_CHEVRON_RIGHT;
        }
      }
    });
  }

  const user = await loadMe();
  const route = parseRoute();

  if (!user) {
    if (route.page !== 'login' && route.page !== 'signup') {
      navigateTo(authPath('login', getPath()));
      return;
    }
    render();
    return;
  }

  try {
  await loadGroup();
  await loadUsers();
    await loadBlocks();
    await loadInbox();
    await loadFriends();
    await loadNotificationPrefs();
  connectSocket();
    maybeAskNotificationPermission();
    if (!window._notifModalCheckBound) {
      window._notifModalCheckBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') ensureNotificationPermissionModalVisible();
      });
      setInterval(ensureNotificationPermissionModalVisible, 10000);
    }

  const path = getPath();
  if (path === '/' || path === '') {
      navigateTo(getRedirectOrDefault());
    return;
  }
  applyRoute(route);
  } catch (err) {
    if (err?.status === 401 && typeof window !== 'undefined' && window.self !== window.top) {
      state.user = null;
      state.authError = 'App is in an iframe but the session cookie was not sent. Ensure the server allows iframe embedding (ALLOW_IFRAME is not "false") and the app is served over HTTPS. Some browsers block third-party cookies in iframes.';
      navigateTo(authPath('login', getPath()));
      return;
    }
    throw err;
  }
}

function showDndCityModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal dnd-modal" style="max-width: 320px;">
      <h3>${t('dndEnterCity')}</h3>
      <p class="modal-hint">${t('dndCityHint')}</p>
      <input type="text" id="dnd-city-input" placeholder="${t('dndCityPlaceholder')}" style="width:100%;margin:0.5rem 0;padding:0.5rem;border:var(--border-width) solid var(--border);border-radius:6px;background:var(--bg-main);color:var(--text)" />
      <div class="modal-actions">
        <button type="button" id="dnd-city-cancel" class="modal-close">${t('dndCancel')}</button>
        <button type="button" id="dnd-city-ok" class="btn-primary">${t('dndSet')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#dnd-city-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#dnd-city-ok')?.addEventListener('click', async () => {
    const input = overlay.querySelector('#dnd-city-input');
    const city = input?.value?.trim();
    if (!city) return;
    const ok = await resolveDndTimezoneFromCity(city);
    overlay.remove();
    if (ok) render();
  });
  const onEscape = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEscape); } };
  document.addEventListener('keydown', onEscape);
  overlay.querySelector('#dnd-city-input')?.focus();
}

function showDndModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal dnd-modal" style="max-width: 320px;">
      <h3>${t('doNotDisturb')}</h3>
      <div class="dnd-modal-inputs">
        <label><span>${t('dndDays')}</span><input type="number" id="dnd-days" min="0" value="0" /></label>
        <label><span>${t('dndHours')}</span><input type="number" id="dnd-hours" min="0" value="0" /></label>
        <label><span>${t('dndMinutes')}</span><input type="number" id="dnd-minutes" min="0" value="0" /></label>
        <label><span>${t('dndSeconds')}</span><input type="number" id="dnd-seconds" min="0" value="0" /></label>
      </div>
      <div class="modal-actions">
        <button type="button" id="dnd-modal-cancel" class="modal-close">${t('dndCancel')}</button>
        <button type="button" id="dnd-modal-set" class="btn-primary">${t('dndSet')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#dnd-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#dnd-modal-set')?.addEventListener('click', async () => {
    const days = Math.max(0, parseInt(overlay.querySelector('#dnd-days')?.value || '0', 10));
    const hours = Math.max(0, parseInt(overlay.querySelector('#dnd-hours')?.value || '0', 10));
    const minutes = Math.max(0, parseInt(overlay.querySelector('#dnd-minutes')?.value || '0', 10));
    const seconds = Math.max(0, parseInt(overlay.querySelector('#dnd-seconds')?.value || '0', 10));
    const totalMs = (days * 86400 + hours * 3600 + minutes * 60 + seconds) * 1000;
    if (totalMs <= 0) { overlay.remove(); return; }
    const dnd_until = Date.now() + totalMs;
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_until });
      overlay.remove();
      render();
    } catch (_) {}
  });
  const onEscape = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEscape); } };
  document.addEventListener('keydown', onEscape);
}

function showPasswordModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 400px;">
      <h3>${t('changePassword')}</h3>
      <p class="modal-hint">${t('changePasswordDesc')}</p>
      <form id="password-modal-form">
        <label>${t('currentPassword')}</label>
        <input type="password" name="current_password" autocomplete="current-password" placeholder="${t('currentPassword')}" />
        <label>${t('newPassword')}</label>
        <input type="password" name="new_password" autocomplete="new-password" placeholder="${t('atLeast6')}" />
        <label>${t('confirmNewPassword')}</label>
        <input type="password" name="new_password_confirm" autocomplete="new-password" placeholder="${t('confirmNewPasswordPlaceholder')}" />
        <p id="password-modal-message" class="settings-form-message" aria-live="polite"></p>
        <div class="modal-actions">
          <button type="button" id="password-modal-cancel" class="modal-close">${t('cancel')}</button>
          <button type="submit" class="btn-primary">${t('changePassword')}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#password-modal-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#password-modal-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const msgEl = overlay.querySelector('#password-modal-message');
    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn?.disabled) return;
    const currentInput = form.querySelector('input[name="current_password"]');
    const newInput = form.querySelector('input[name="new_password"]');
    const confirmInput = form.querySelector('input[name="new_password_confirm"]');
    const current = (currentInput?.value ?? '').trim();
    const newPass = (newInput?.value ?? '').trim();
    const confirm = (confirmInput?.value ?? '').trim();
    if (!current || !newPass) {
      if (msgEl) { msgEl.textContent = t('fillCurrentNew'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass.length < 6) {
      if (msgEl) { msgEl.textContent = t('newPasswordMin'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (newPass !== confirm) {
      if (msgEl) { msgEl.textContent = t('newPasswordMismatch'); msgEl.dataset.type = 'error'; }
      return;
    }
    if (msgEl) msgEl.textContent = '';
    if (submitBtn) submitBtn.disabled = true;
    try {
      const payload = { current_password: current, new_password: newPass };
      await apiPatch('/api/users/password', payload);
      if (msgEl) { msgEl.textContent = t('passwordChanged'); msgEl.dataset.type = 'success'; }
      form.reset();
      setTimeout(() => overlay.remove(), 800);
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message || t('failedChangePassword'); msgEl.dataset.type = 'error'; }
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function bindSettings() {
  document.getElementById('settings-theme')?.addEventListener('change', (e) => {
    const theme = e.target.value;
    state.theme = theme;
    if (typeof localStorage !== 'undefined') localStorage.setItem('theme', theme);
    applyTheme(theme);
    setState({});
  });
  document.getElementById('settings-language')?.addEventListener('change', (e) => {
    const lang = e.target.value;
    state.language = lang;
    if (typeof localStorage !== 'undefined') localStorage.setItem('language', lang);
    if (document.documentElement) document.documentElement.setAttribute('lang', lang);
    setState({});
    render();
  });
  document.getElementById('notif-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      const prefs = await apiPatch('/api/notifications/prefs', { enabled });
      state.notificationPrefs = prefs;
      document.getElementById('notif-triggers')?.style.setProperty('opacity', enabled ? '1' : '0.5');
      document.getElementById('notif-triggers')?.style.setProperty('pointer-events', enabled ? 'auto' : 'none');
      document.getElementById('notif-dnd')?.style.setProperty('opacity', enabled ? '1' : '0.5');
      document.getElementById('notif-dnd')?.style.setProperty('pointer-events', enabled ? 'auto' : 'none');
      if (enabled) Notification.requestPermission();
    } catch (_) {}
  });
  document.getElementById('notif-mails')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_mails: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-dm')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_dm: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-group')?.addEventListener('change', async (e) => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { notify_group: !!e.target.checked });
    } catch (_) {}
  });
  document.getElementById('notif-dnd-open')?.addEventListener('click', showDndModal);
  document.getElementById('notif-dnd-end-now')?.addEventListener('click', async () => {
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_until: null });
      render();
    } catch (_) {}
  });
  document.getElementById('notif-dnd-at-night')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    try {
      state.notificationPrefs = await apiPatch('/api/notifications/prefs', { dnd_at_night: enabled });
      if (enabled && !getDndTimezone()) resolveDndTimezoneFromLocation().then(() => render());
    } catch (_) {}
  });
  document.getElementById('notif-dnd-use-location')?.addEventListener('click', async () => {
    const ok = await resolveDndTimezoneFromLocation();
    if (ok) render();
  });
  document.getElementById('notif-dnd-enter-city')?.addEventListener('click', showDndCityModal);
  document.getElementById('open-password-modal')?.addEventListener('click', showPasswordModal);
  document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
    await apiPost('/api/auth/logout');
    state.user = null;
    state.socket?.disconnect();
    state.socket = null;
    navigateTo('/login');
  });
  document.getElementById('profile-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    if (state._pendingAvatarFile) {
      formData.set('avatar', state._pendingAvatarFile);
      state._pendingAvatarFile = null;
      if (state._pendingAvatarObjectUrl) {
        URL.revokeObjectURL(state._pendingAvatarObjectUrl);
        state._pendingAvatarObjectUrl = null;
      }
    }
    try {
      const res = await fetch('/api/users/profile', {
        method: 'PATCH',
        credentials: 'include',
        body: formData,
      });
      if (res.status === 401) {
        state.user = null;
        state.authError = 'Session expired. Please log in again.';
        navigateTo('/login');
        return;
      }
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {}
      if (!res.ok) throw new Error(data.error || res.statusText);
      state.user = data.user;
      state.user._avatarVersion = Date.now();
      setState({});
    } catch (err) {
      showToast(err.message);
    }
  });

  const profileForm = document.getElementById('profile-form');
  const avatarFileInput = profileForm?.querySelector('input[name="avatar"]');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

  const settingsAvatarDrop = document.getElementById('settings-avatar-drop-zone');
  if (settingsAvatarDrop) {
    ['dragenter', 'dragover'].forEach((ev) => {
      settingsAvatarDrop.addEventListener(ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.types.includes('Files')) settingsAvatarDrop.classList.add('settings-avatar-drag-over');
      });
    });
    settingsAvatarDrop.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (!settingsAvatarDrop.contains(e.relatedTarget)) settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
    });
    settingsAvatarDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      settingsAvatarDrop.classList.remove('settings-avatar-drag-over');
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      if (state._pendingAvatarObjectUrl) URL.revokeObjectURL(state._pendingAvatarObjectUrl);
      state._pendingAvatarFile = file;
      state._pendingAvatarObjectUrl = URL.createObjectURL(file);
      const preview = document.getElementById('avatar-preview');
      if (preview) preview.src = state._pendingAvatarObjectUrl;
      setState({});
    });
  }

}

function bindInbox() {
  document.getElementById('inbox-list')?.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.inbox-item-delete');
    if (deleteBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = deleteBtn.dataset.inboxId;
      if (!confirm(t('deleteMailConfirm'))) return;
      try {
        await apiDelete(`/api/inbox/${encodeURIComponent(inboxId)}`);
        await loadInbox();
        render();
        bindInbox();
      } catch (err) { showToast(err.message || 'Failed to delete'); }
      return;
    }
    const acceptBtn = e.target.closest('.inbox-accept-fr');
    const rejectBtn = e.target.closest('.inbox-reject-fr');
    if (acceptBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = acceptBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/accept', { inbox_id: inboxId });
        await loadInbox();
        await loadFriends();
        render();
        bindInbox();
      } catch (err) { showToast(err.message); }
      return;
    }
    if (rejectBtn) {
      e.preventDefault();
      e.stopPropagation();
      const inboxId = rejectBtn.dataset.inboxId;
      try {
        await apiPost('/api/friends/reject', { inbox_id: inboxId });
        await loadInbox();
        render();
        bindInbox();
      } catch (err) { showToast(err.message); }
      return;
    }
    const item = e.target.closest('.inbox-item');
    if (!item) return;
    const id = item.dataset.id;
    const relatedId = item.dataset.related;
    const extraStr = item.dataset.extra;
    await fetch(`/api/inbox/${id}/read`, { method: 'POST', credentials: 'include' });
    await loadInbox();
    render();
    bindInbox();
    try {
      const extra = extraStr ? JSON.parse(extraStr) : {};
      if (extra.panel === 'problem_solving') navigateTo('/chat/group/?panel=problem');
    } catch (_) {}
  });
}

init();
