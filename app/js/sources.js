/* =============================================================
 * sources.js  v2 — 音源适配层（纯前端 / 无服务器）
 * -------------------------------------------------------------
 * 设计要点
 *   1. PROVIDERS 注册表：每条源声明能力(search/url/lyric/pic)、
 *      音质档位(tier)、权重，便于随时增删。
 *   2. 繁简归一 + scoreMatchV2：JOOX 返回繁体（「起風了」），
 *      旧版匹配直接归零，这是无损放不出来的根因。
 *   3. raceWeighted：并发竞速 + 宽限窗口。无损档先到直接用；
 *      低档先到则等一个宽限期，给无损留机会。
 *   4. 跨源取声：搜索显示网易/QQ 的元数据，播放时自动到
 *      JOOX 找同一首歌拿 FLAC，播放条显示真实来源与码率。
 * ============================================================= */
(function (global) {
  'use strict';

  /* ==========================================================
   * 0. 常量与配置
   * ========================================================== */

  // 注意：本仓库不内置任何上游音源域名。所有音源地址都由使用者在
  // sources.config.js 中通过 Sources.registerProvider(...) 自行提供。

  var TIER = { LOSSLESS: 0, HIGH: 1, PREVIEW: 2 };

  var settings = {
    quality: 999,        // 999 无损优先 / 320 / 192 / 128
    crossMatch: true,    // 跨源取声总开关
    preferLossless: true,
    customSearch: '',    // 自定义源（LX 风格占位符）
    customUrl: '',
    graceMs: 2200,       // 低档命中后，等无损的宽限窗口
    hardTimeout: 14000
  };

  /* ==========================================================
   * 1. 基础工具
   * ========================================================== */

  function noop() {}

  function timeout(ms) {
    return new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error('timeout')); }, ms);
    });
  }

  /** 带超时的 fetch；失败一律抛错，交由上层降级 */
  function http(url, opt) {
    opt = opt || {};
    var ms = opt.timeout || 11000;
    var ctl = null;
    try { ctl = new AbortController(); } catch (e) {}
    var p = fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: opt.noCache ? 'no-store' : 'default',
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return opt.text ? r.text() : r.json();
    });
    var t = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, ms);
    return Promise.race([p, timeout(ms)]).then(
      function (v) { clearTimeout(t); return v; },
      function (e) { clearTimeout(t); throw e; }
    );
  }

  /** JSONP —— 用来打 QQ 官方接口，file:// 下同样有效 */
  var jsonpSeq = 0;
  function jsonp(url, opt) {
    opt = opt || {};
    var cbName = '__mh_cb_' + (Date.now().toString(36)) + '_' + (jsonpSeq++);
    var param = opt.cbParam || 'jsonpCallback';
    var ms = opt.timeout || 9000;
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      var done = false;
      var timer = setTimeout(function () { finish(new Error('jsonp timeout')); }, ms);

      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete global[cbName]; } catch (e) { global[cbName] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        err ? reject(err) : resolve(data);
      }

      global[cbName] = function (data) { finish(null, data); };
      s.onerror = function () { finish(new Error('jsonp network')); };
      s.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=' + cbName +
              '&callback=' + cbName + '&format=jsonp&inCharset=utf-8&outCharset=utf-8';
      s.charset = 'utf-8';
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }

  function toArr(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

  function joinArtist(a) {
    if (Array.isArray(a)) {
      return a.map(function (x) {
        return (x && typeof x === 'object') ? (x.name || x.title || '') : String(x || '');
      }).filter(Boolean).join(' / ');
    }
    return String(a || '');
  }

  /* ==========================================================
   * 2. 繁简归一（跨源匹配的地基）
   * ----------------------------------------------------------
   * 成对书写，天然对齐，不会像双字符串那样错位。
   * 覆盖歌名/歌手常见字，约 700 组。
   * ========================================================== */

  var T2S_PAIRS =
    '愛爱礙碍擺摆敗败辦办幫帮綁绑寶宝報报備备貝贝筆笔畢毕閉闭邊边編编變变標标錶表別别賓宾餅饼並并撥拨補补' +
    '財财參参蠶蚕慘惨倉仓側侧測测層层纏缠場场嘗尝長长償偿腸肠廠厂暢畅車车徹彻塵尘陳陈襯衬稱称誠诚遲迟馳驰' +
    '齒齿衝冲蟲虫寵宠籌筹綢绸醜丑廚厨觸触處处傳传瘡疮闖闯創创錘锤純纯詞词賜赐聰聪蔥葱從从叢丛竄窜錯错達达' +
    '帶带貸贷擔担單单膽胆當当黨党蕩荡檔档導导島岛燈灯鄧邓敵敌遞递締缔點点電电墊垫釣钓調调疊叠東东動动棟栋' +
    '凍冻鬥斗獨独讀读賭赌鍛锻斷断緞缎隊队對对噸吨頓顿鈍钝奪夺墮堕鵝鹅額额惡恶餓饿兒儿爾尔貳贰發发罰罚閥阀' +
    '煩烦範范販贩飯饭訪访紡纺飛飞廢废費费紛纷墳坟奮奋憤愤豐丰風风楓枫瘋疯馮冯縫缝諷讽鳳凤膚肤撫抚輔辅賦赋' +
    '復复負负婦妇縛缚該该鈣钙蓋盖幹干趕赶剛刚鋼钢綱纲崗岗擱搁鴿鸽閣阁給给龔龚貢贡溝沟構构購购夠够顧顾掛挂' +
    '關关觀观館馆慣惯貫贯廣广規规歸归龜龟軌轨櫃柜貴贵滾滚鍋锅國国過过韓韩漢汉鶴鹤賀贺轟轰鴻鸿紅红後后壺壶' +
    '護护滬沪戶户嘩哗華华畫画劃划話话懷怀壞坏歡欢環环還还緩缓換换喚唤黃黄謊谎揮挥輝辉毀毁賄贿會会匯汇繪绘' +
    '渾浑夥伙獲获貨货禍祸擊击機机積积飢饥譏讥雞鸡績绩極极級级擠挤幾几劑剂濟济計计記记際际繼继紀纪夾夹頰颊' +
    '價价駕驾監监堅坚間间艱艰繭茧檢检鹼碱揀拣撿捡簡简儉俭減减薦荐鑒鉴踐践賤贱見见鍵键艦舰劍剑漸渐獎奖講讲' +
    '醬酱膠胶澆浇驕骄嬌娇攪搅腳脚餃饺繳缴絞绞轎轿較较階阶節节莖茎驚惊經经頸颈靜静鏡镜徑径競竞淨净糾纠舊旧' +
    '舉举據据鋸锯懼惧劇剧鵑鹃捲卷絹绢軍军駿骏開开凱凯顆颗殼壳課课墾垦懇恳庫库褲裤誇夸塊块寬宽礦矿曠旷況况' +
    '虧亏窺窥潰溃擴扩闊阔蠟蜡臘腊來来賴赖藍蓝欄栏攔拦籃篮蘭兰瀾澜攬揽覽览懶懒纜缆爛烂濫滥撈捞勞劳樂乐壘垒' +
    '類类淚泪離离裡里鯉鲤禮礼麗丽厲厉勵励歷历瀝沥倆俩聯联蓮莲連连鐮镰憐怜漣涟簾帘斂敛臉脸鏈链戀恋煉炼練练' +
    '糧粮涼凉兩两輛辆諒谅療疗遼辽獵猎臨临鄰邻鱗鳞賃赁齡龄鈴铃靈灵嶺岭領领劉刘龍龙聾聋嚨咙籠笼壟垄攏拢樓楼' +
    '摟搂蘆芦盧卢廬庐爐炉魯鲁賂赂錄录陸陆驢驴呂吕鋁铝侶侣屢屡縷缕慮虑濾滤綠绿亂乱輪轮倫伦淪沦論论蘿萝羅罗' +
    '邏逻鑼锣籮箩騾骡駱骆絡络媽妈瑪玛碼码螞蚂馬马罵骂買买麥麦賣卖邁迈脈脉瞞瞒饅馒蠻蛮滿满貓猫貿贸麼么黴霉' +
    '鎂镁門门悶闷們们夢梦謎谜彌弥綿绵緬缅廟庙滅灭閩闽鳴鸣銘铭謬谬謀谋畝亩鈉钠納纳難难腦脑惱恼鬧闹餒馁內内' +
    '擬拟膩腻釀酿鳥鸟鎳镍檸柠寧宁擰拧鈕钮紐纽膿脓濃浓農农諾诺歐欧鷗鸥毆殴嘔呕盤盘龐庞賠赔鵬鹏闢辟鋪铺樸朴' +
    '譜谱臍脐齊齐騎骑豈岂啟启氣气棄弃牽牵鉛铅遷迁簽签謙谦錢钱鉗钳潛潜淺浅譴谴槍枪牆墙薔蔷強强搶抢鍬锹橋桥' +
    '喬乔僑侨翹翘竅窍竊窃欽钦親亲輕轻氫氢傾倾頃顷請请慶庆瓊琼窮穷趨趋區区軀躯驅驱權权勸劝卻却鵲鹊讓让饒饶' +
    '擾扰繞绕熱热韌韧認认紉纫榮荣絨绒軟软銳锐閏闰潤润灑洒薩萨賽赛傘伞喪丧騷骚掃扫澀涩殺杀紗纱篩筛曬晒閃闪' +
    '陝陕贍赡傷伤賞赏燒烧紹绍攝摄設设紳绅審审嬸婶腎肾滲渗聲声繩绳勝胜師师獅狮濕湿詩诗屍尸時时蝕蚀實实識识' +
    '駛驶勢势釋释飾饰視视試试壽寿獸兽樞枢輸输書书贖赎屬属術术樹树豎竖數数帥帅雙双誰谁稅税順顺說说碩硕絲丝' +
    '飼饲聳耸頌颂訟讼誦诵蘇苏訴诉肅肃雖虽歲岁孫孙損损筍笋縮缩瑣琐鎖锁臺台態态攤摊癱瘫灘滩壇坛譚谭談谈歎叹' +
    '湯汤燙烫濤涛騰腾題题體体屜屉條条貼贴鐵铁廳厅聽听銅铜統统頭头圖图塗涂團团頹颓脫脱鴕鸵馱驮駝驼橢椭窪洼' +
    '襪袜彎弯灣湾頑顽萬万網网韋韦違违圍围為为維维葦苇偉伟偽伪緯纬謂谓衛卫溫温聞闻紋纹穩稳問问甕瓮渦涡窩窝' +
    '臥卧嗚呜鎢钨烏乌誣诬無无蕪芜吳吴塢坞霧雾務务誤误錫锡犧牺襲袭習习銑铣戲戏細细蝦虾轄辖峽峡俠侠狹狭廈厦' +
    '嚇吓鮮鲜纖纤鹹咸賢贤銜衔閑闲顯显險险現现獻献縣县餡馅憲宪線线廂厢鑲镶鄉乡詳详響响項项蕭萧銷销曉晓嘯啸' +
    '蠍蝎協协挾挟攜携脅胁諧谐寫写瀉泻謝谢鋅锌釁衅興兴洶汹鏽锈繡绣噓嘘須须許许緒绪續续軒轩懸悬選选癬癣絢绚' +
    '學学勳勋詢询尋寻馴驯訓训訊讯遜逊壓压鴉鸦鴨鸭啞哑亞亚訝讶閹阉煙烟鹽盐嚴严顏颜閻阎豔艳厭厌硯砚諺谚驗验' +
    '鴦鸯楊杨揚扬瘍疡陽阳癢痒養养樣样瑤瑶搖摇堯尧遙遥窯窑謠谣藥药爺爷頁页業业葉叶醫医頤颐遺遗儀仪蟻蚁藝艺' +
    '億亿憶忆義义詣诣議议誼谊譯译異异繹绎蔭荫陰阴銀银飲饮隱隐嬰婴纓缨櫻樱鷹鹰應应螢萤營营熒荧蠅蝇穎颖喲哟' +
    '擁拥傭佣癰痈踴踊詠咏湧涌優优憂忧郵邮鈾铀猶犹遊游誘诱輿舆魚鱼漁渔娛娱與与嶼屿語语獄狱譽誉預预馭驭鴛鸳' +
    '淵渊轅辕園园員员圓圆緣缘遠远願愿約约躍跃鑰钥嶽岳粵粤悅悦閱阅雲云勻匀隕陨運运蘊蕴暈晕韻韵雜杂災灾載载' +
    '攢攒暫暂贊赞贓赃髒脏鑿凿棗枣責责擇择則则澤泽賊贼贈赠紮扎軋轧閘闸柵栅詐诈齋斋債债氈毡盞盏斬斩輾辗嶄崭' +
    '棧栈戰战綻绽張张漲涨帳帐賬账脹胀趙赵蟄蛰轍辙這这貞贞針针偵侦診诊鎮镇陣阵掙挣睜睁猙狰幀帧鄭郑證证織织' +
    '職职執执紙纸摯挚擲掷幟帜質质滯滞終终鐘钟種种腫肿眾众謅诌軸轴皺皱晝昼驟骤豬猪諸诸誅诛燭烛矚瞩囑嘱貯贮' +
    '鑄铸築筑駐驻專专磚砖轉转賺赚樁桩莊庄裝装妝妆壯壮狀状錐锥贅赘墜坠綴缀諄谆濁浊茲兹資资漬渍蹤踪綜综總总' +
    '縱纵鄒邹詛诅組组鑽钻嶇岖噹当喎歪唸念嗎吗嘸呒噴喷嚐尝嚕噜嚥咽囉啰壎埙壩坝奐奂' +
    // —— 补遗：歌名/歌手高频，前一批遗漏 ——
    '傑杰髮发覺觉隨随飄飘餘余贏赢輩辈騙骗繫系纍累淒凄爭争徵征麵面鬆松檯台裏里慾欲藉借儘尽盡尽燦灿憑凭' +
    '斃毙敘叙屆届幣币廁厕彆别蟬蝉訂订討讨託托誌志迴回醞酝鈔钞鏢镖饋馈癡痴甯宁瑩莹稜棱脣唇臟脏舖铺艙舱' +
    '衆众羣群睏困矇蒙籤签蹺跷雋隽鞦秋韆千皚皑殞殒歿殁慼戚懨恹嚮向嚀咛噁恶嘮唠嘰叽唄呗奧奥峯峰喫吃甦苏' +
    '燼烬麯曲蔔卜鬍胡鬚须魎魉魘魇鯨鲸鴉鸦鵰雕鶯莺鷺鹭鹼碱麥麦黌黉齣出攜携攪搅擻擞攏拢曖暧曇昙朧胧枴拐' +
    '棄弃檳槟櫥橱歎叹殼壳氬氩沖冲淚泪湞浈滾滚潑泼瀋沈灝灏燄焰爍烁牽牵猻狲獃呆瑣琐甕瓮痺痹瘂痖癲癫皰疱' +
    '瞭了矓眬硃朱磯矶祿禄禪禅穫获窮穷筧笕篋箧簫箫籲吁糰团絃弦繽缤纖纤纘缵罈坛聶聂聹聍脛胫腦脑膽胆臘腊' +
    '艤舣艦舰蘋苹蘚藓蟶蛏蠔蚝褸褛襤褴訃讣訥讷詼诙誒诶諂谄謐谧譁哗讚赞豐丰賈贾贗赝贛赣嘆叹號号躋跻輓挽' +
    '轡辔遙遥邇迩鄰邻酈郦醬酱釐厘鈺钰鉤钩銬铐鋸锯錶表鍥锲鎊镑鏗铿鐮镰鑑鉴閂闩閏闰闕阙闥闼陘陉隸隶雛雏' +
    '靂雳靚靓鞏巩韃鞑頇顸顛颠飩饨餚肴饜餍駁驳騖骛髖髋鬢鬓魷鱿鰭鳍鱷鳄鷥鸶鹺鹾慚惭謹谨嬋婵縈萦';

  var T2S = (function () {
    var m = Object.create(null);
    for (var i = 0; i + 1 < T2S_PAIRS.length; i += 2) {
      m[T2S_PAIRS.charAt(i)] = T2S_PAIRS.charAt(i + 1);
    }
    return m;
  })();

  function t2s(str) {
    if (!str) return '';
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      out += (T2S[c] || c);
    }
    return out;
  }

  /* ==========================================================
   * 3. 标题归一 / 版本标签 / 匹配打分 V2
   * ========================================================== */

  /** 括号里的内容单独提取，用于判定「同名不同版本」 */
  var BRACKET_RE = /[（(\[【｛{]([^）)\]】｝}]*)[）)\]】｝}]/g;

  /** 版本关键词 —— 命中不同版本视为不同曲目 */
  var VARIANTS = [
    ['live', /\b(live|演唱会|现场|concert)\b/i],
    ['inst', /(伴奏|instrumental|karaoke|off vocal|纯音乐)/i],
    ['piano', /(钢琴版|piano)/i],
    ['guitar', /(吉他版|guitar)/i],
    ['cover', /\b(cover|翻唱|翻自)\b/i],
    ['remix', /\b(remix|混音|dj)\b/i],
    ['acoustic', /(acoustic|不插电)/i],
    ['demo', /\bdemo\b/i],
    ['radio', /(radio edit|电台版)/i],
    ['sped', /(加速版|sped ?up|nightcore)/i],
    ['slowed', /(减速版|slowed)/i],
    ['tv', /(tv ?(size|ver)|动画版)/i],
    ['film', /(电影版|影视原声|ost)/i],
    ['remaster', /(remaster|重制|复刻)/i]
  ];

  function variantTags(raw) {
    var s = t2s(String(raw || '').toLowerCase());
    var tags = [];
    for (var i = 0; i < VARIANTS.length; i++) {
      if (VARIANTS[i][1].test(s)) tags.push(VARIANTS[i][0]);
    }
    return tags;
  }

  /** 剥掉括号、符号、空格，繁转简，全角转半角 */
  function normalizeTitle(s) {
    if (!s) return '';
    var x = t2s(String(s));
    x = x.replace(/[\uFF01-\uFF5E]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    });
    x = x.toLowerCase();
    x = x.replace(BRACKET_RE, ' ');
    x = x.replace(/[\s\-_·・,，.。!！?？'"''""~～/\\|:：;；&+*#@^%$]/g, '');
    return x.trim();
  }

  function normalizeArtist(s) {
    var x = normalizeTitle(joinArtist(s));
    // 常见别名折叠
    x = x.replace(/jaychou|周杰倫/g, '周杰伦');
    return x;
  }

  /** 只做繁简+去符号，保留括号内容本身（用于副标题比对） */
  function normalizePlain(s) {
    if (!s) return '';
    var x = t2s(String(s)).replace(/[\uFF01-\uFF5E]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    }).toLowerCase();
    return x.replace(/[\s\-_·・,，.。!！?？'"''""~～/\\|:：;；&+*#@^%$]/g, '').trim();
  }

  /** 抽出所有括号内的文字并归一，用于判断副标题是否一致 */
  function bracketInner(s) {
    var re = new RegExp(BRACKET_RE.source, 'g');
    var out = [], m;
    while ((m = re.exec(String(s || ''))) !== null) {
      if (m[1]) out.push(m[1]);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    return normalizePlain(out.join(''));
  }

  /** 编辑距离（带上限，超限提前退出） */
  function editDist(a, b, cap) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    var prev = new Array(lb + 1), cur = new Array(lb + 1), i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var best = cur[0];
      for (j = 1; j <= lb; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < best) best = cur[j];
      }
      if (best > cap) return cap + 1;
      for (j = 0; j <= lb; j++) prev[j] = cur[j];
    }
    return prev[lb];
  }

  function simRatio(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    if (a === b) return 1;
    var max = Math.max(a.length, b.length);
    var d = editDist(a, b, Math.ceil(max * 0.5));
    if (d > max) return 0;
    return 1 - d / max;
  }

  /**
   * 跨源匹配打分（0~100）
   * 曲名 55 分 + 歌手 30 分 + 时长 10 分 + 专辑 5 分，版本标签冲突重罚。
   */
  function scoreMatchV2(want, got) {
    if (!want || !got) return 0;

    var wt = normalizeTitle(want.name);
    var gt = normalizeTitle(got.name);
    if (!wt || !gt) return 0;

    var score = 0;

    // --- 曲名 ---
    var tSim;
    if (wt === gt) tSim = 1;
    else if (gt.indexOf(wt) === 0 || wt.indexOf(gt) === 0) tSim = 0.9;
    else if (gt.indexOf(wt) >= 0 || wt.indexOf(gt) >= 0) tSim = 0.78;
    else tSim = simRatio(wt, gt);
    if (tSim < 0.55) return 0;              // 名字都对不上，直接毙
    score += tSim * 55;

    // --- 歌手 ---
    var wa = normalizeArtist(want.artist);
    var ga = normalizeArtist(got.artist);
    var aSim = 0;
    if (!wa || !ga) {
      aSim = 0.5;                            // 缺歌手信息，给中性分
    } else if (wa === ga) {
      aSim = 1;
    } else if (ga.indexOf(wa) >= 0 || wa.indexOf(ga) >= 0) {
      aSim = 0.88;
    } else {
      // 多歌手：任一交集即可
      var wl = String(want.artist || '').split(/[\/、,，&]/).map(normalizeArtist).filter(Boolean);
      var gl = joinArtist(got.artist).split(/[\/、,，&]/).map(normalizeArtist).filter(Boolean);
      var hit = 0;
      for (var i = 0; i < wl.length; i++) {
        for (var j = 0; j < gl.length; j++) {
          if (wl[i] && gl[j] && (wl[i] === gl[j] || simRatio(wl[i], gl[j]) > 0.8)) { hit = 1; break; }
        }
        if (hit) break;
      }
      aSim = hit ? 0.85 : simRatio(wa, ga);
    }
    score += aSim * 30;

    // --- 时长（±3 秒满分，±10 秒及格） ---
    var wd = Number(want.duration) || 0;
    var gd = Number(got.duration) || 0;
    if (wd > 10 && gd > 10) {
      var diff = Math.abs(wd - gd);
      if (diff <= 3) score += 10;
      else if (diff <= 10) score += 6;
      else if (diff <= 20) score += 2;
      else score -= 14;                      // 时长差太多，多半是别的版本
    } else {
      score += 5;
    }

    // --- 专辑 ---
    var walb = normalizeTitle(want.album), galb = normalizeTitle(got.album);
    if (walb && galb) {
      if (walb === galb) score += 5;
      else if (walb.indexOf(galb) >= 0 || galb.indexOf(walb) >= 0) score += 3;
    }

    // --- 版本标签冲突 ---
    var wv = variantTags((want.name || '') + ' ' + (want.album || ''));
    var gv = variantTags((got.name || '') + ' ' + (got.album || ''));
    var wsig = wv.sort().join(','), gsig = gv.sort().join(',');
    if (wsig !== gsig) {
      // 目标是原版，命中的是 live/伴奏/翻唱 → 重罚
      score -= (wv.length === 0 && gv.length > 0) ? 30 : 18;
    }

    // --- 括号内容差异（副标题 / 版本注记） ---
    var wb = bracketInner(want.name);
    var gb = bracketInner(got.name);
    if (wb !== gb) {
      if (!wb && gb) {
        // 想要原版，命中的带副标题：轻罚（可能只是「動畫主題曲」这类注记）
        score -= /(舊版|旧版|新版|重制|重錄|重录|版本|ver)/.test(gb) ? 10 : 5;
      } else if (wb && !gb) {
        score -= 8;
      } else {
        score -= (wb.indexOf(gb) >= 0 || gb.indexOf(wb) >= 0) ? 3 : 9;
      }
    }

    return Math.max(0, Math.min(100, score));
  }

  var MATCH_ACCEPT = 72;   // 可用
  var MATCH_STRONG = 86;   // 高置信，直接免二次校验

  /* ==========================================================
   * 4. 音质推断
   * ========================================================== */

  var QUALITY_TABLE = [
    { min: 1400, key: 'hires', label: 'Hi-Res', short: 'Hi-Res' },
    { min: 700,  key: 'sq',    label: '无损',   short: 'SQ' },
    { min: 300,  key: 'hq',    label: '320K',   short: 'HQ' },
    { min: 180,  key: 'mq',    label: '192K',   short: 'MQ' },
    { min: 90,   key: 'lq',    label: '128K',   short: 'LQ' },
    { min: 0,    key: 'trial', label: '试听',   short: '试听' }
  ];

  function extOf(url) {
    var m = String(url || '').split('?')[0].match(/\.(flac|ape|wav|m4a|aac|mp3|ogg|opus)$/i);
    return m ? m[1].toLowerCase() : '';
  }

  /** 有 size+duration 就算真实码率；否则靠后缀与接口 br 兜底 */
  function inferQuality(url, size, duration, brHint) {
    var format = extOf(url);
    var kbps = 0;
    if (size > 0 && duration > 5) kbps = Math.round(size * 8 / duration / 1000);
    if (!kbps && brHint > 0) kbps = brHint > 1000 ? brHint : brHint;

    var lossless = /^(flac|ape|wav)$/.test(format);
    if (lossless && kbps < 700) kbps = kbps || 900;

    var q = QUALITY_TABLE[QUALITY_TABLE.length - 1];
    for (var i = 0; i < QUALITY_TABLE.length; i++) {
      if (kbps >= QUALITY_TABLE[i].min) { q = QUALITY_TABLE[i]; break; }
    }

    var label = q.label;
    if (lossless) label = (kbps >= 1400 ? 'Hi-Res' : '无损') + ' ' + format.toUpperCase();
    else if (kbps > 0) label = kbps + 'K';

    return {
      key: q.key,
      short: q.short,
      label: label,
      kbps: kbps,
      format: format || 'mp3',
      lossless: lossless,
      size: size || 0
    };
  }

  /* ==========================================================
   * 5. 探测：临时 audio 验证可解码 + 读真实时长
   * ========================================================== */

  function probeAudio(url, ms) {
    ms = ms || 6500;
    return new Promise(function (resolve) {
      var a = document.createElement('audio');
      var done = false;
      function fin(ok, dur) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.onloadedmetadata = a.onerror = a.oncanplay = null;
        try { a.src = ''; a.removeAttribute('src'); a.load(); } catch (e) {}
        resolve({ ok: ok, duration: dur || 0 });
      }
      var timer = setTimeout(function () { fin(false, 0); }, ms);
      a.preload = 'metadata';
      a.onloadedmetadata = function () { fin(true, a.duration || 0); };
      a.oncanplay = function () { fin(true, a.duration || 0); };
      a.onerror = function () { fin(false, 0); };
      try { a.src = url; a.load(); } catch (e) { fin(false, 0); }
    });
  }

  /* ==========================================================
   * 6. 缓存（内存 + localStorage，带 TTL）
   * ========================================================== */

  var MEM = Object.create(null);
  var LS_KEY = 'musichub.v2.urlcache';
  var URL_TTL = 18 * 60 * 1000;   // 直链一般 20~30 分钟过期，保守取 18
  var META_TTL = 30 * 60 * 1000;

  function cacheGet(k) {
    var v = MEM[k];
    if (v && v.exp > Date.now()) return v.val;
    if (v) delete MEM[k];
    return null;
  }
  function cacheSet(k, val, ttl) {
    MEM[k] = { val: val, exp: Date.now() + (ttl || META_TTL) };
  }

  function lsCacheGet(k) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      var v = all[k];
      if (v && v.exp > Date.now()) return v.val;
    } catch (e) {}
    return null;
  }
  function lsCacheSet(k, val, ttl) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      var keys = Object.keys(all);
      if (keys.length > 240) {
        keys.sort(function (a, b) { return (all[a].exp || 0) - (all[b].exp || 0); });
        keys.slice(0, 120).forEach(function (x) { delete all[x]; });
      }
      all[k] = { val: val, exp: Date.now() + (ttl || URL_TTL) };
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  /* ==========================================================
   * 7. Track 归一化
   * ========================================================== */

  var uidSeq = 0;
  function mkTrack(o) {
    var platform = o.platform || 'netease';
    var id = String(o.id == null ? ('x' + (uidSeq++)) : o.id);
    return {
      uid: platform + ':' + id,
      platform: platform,
      id: id,
      name: String(o.name || '未知曲目').trim(),
      artist: joinArtist(o.artist) || '未知艺人',
      album: String(o.album || '').trim(),
      duration: Number(o.duration) || 0,
      picId: o.picId != null ? String(o.picId) : '',
      lyricId: o.lyricId != null ? String(o.lyricId) : id,
      urlId: o.urlId != null ? String(o.urlId) : id,
      source: o.source || platform,
      pic: o.pic || '',
      raw: o.raw || null
    };
  }

  /* ==========================================================
   * 8. PROVIDERS —— 音源注册表
   * ========================================================== */

  // 默认 0 音源：本仓库不内置任何音频源（网易云 / QQ / JOOX / 酷我 等）。
  // 所有可用音源都必须由使用者在 sources.config.js 中通过
  //   Sources.registerProvider({ ... }) 自行注册，或直接在设置面板填写「自定义源」模板。
  // 这里仅保留一个完全由用户驱动的占位适配器 custom（不指向任何具体服务）。
  var PROVIDERS = {

    /* ---------- 自定义源（LX Music 风格占位符，需用户自行填写） ---------- */
    'custom': {
      id: 'custom',
      label: '自定义源',
      note: '设置里可填自己的接口，仓库不内置任何源',
      tier: TIER.HIGH,
      weight: 50,
      caps: { search: 1, url: 1 },
      search: function (kw, page, limit) {
        var cs = settings.customSearch || (settings.customSource && settings.customSource.searchUrl);
        if (!cs) throw new Error('未配置自定义搜索地址');
        var u = cs
          .replace(/\{keyword\}/g, enc(kw))
          .replace(/\{page\}/g, page || 1)
          .replace(/\{limit\}/g, limit || 30);
        return http(u, { timeout: 11000 }).then(function (r) {
          var list = Array.isArray(r) ? r : (r.data || r.result || r.songs || []);
          if (!list.length) throw new Error('empty');
          return list.map(function (x) {
            return mkTrack({
              platform: x.platform || 'custom',
              id: x.id || x.mid || x.songid,
              name: x.name || x.song || x.title,
              artist: x.artist || x.singer || x.author,
              album: x.album, duration: parseDur(x.duration || x.time),
              pic: x.pic || x.cover || '', source: 'custom', raw: x
            });
          });
        });
      },
      url: function (track, br) {
        var cu = settings.customUrl || (settings.customSource && settings.customSource.urlUrl);
        if (!cu) throw new Error('未配置自定义播放地址');
        var u = cu
          .replace(/\{id\}/g, enc(track.urlId || track.id))
          .replace(/\{name\}/g, enc(track.name))
          .replace(/\{artist\}/g, enc(track.artist))
          .replace(/\{br\}/g, br || 999);
        return http(u, { timeout: 12000 }).then(function (r) {
          var url = typeof r === 'string' ? r : (r.url || (r.data && r.data.url));
          if (!url) throw new Error('no url');
          return { url: url, br: Number(r.br || r.kbps) || 0, size: parseSize(r.size) };
        });
      }
    }
  };

  function parseDur(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v > 10000 ? Math.round(v / 1000) : Math.round(v);
    var s = String(v).trim();
    var m = /^(\d+):(\d+)(?::(\d+))?$/.exec(s);
    if (m) {
      return m[3] ? (+m[1] * 3600 + +m[2] * 60 + +m[3]) : (+m[1] * 60 + +m[2]);
    }
    var n = parseFloat(s);
    return isNaN(n) ? 0 : (n > 10000 ? Math.round(n / 1000) : Math.round(n));
  }

  function parseSize(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    var s = String(v).trim().toUpperCase();
    var m = /^([\d.]+)\s*(K|M|G)?B?$/.exec(s);
    if (!m) return 0;
    var n = parseFloat(m[1]);
    var mul = m[2] === 'G' ? 1073741824 : m[2] === 'M' ? 1048576 : m[2] === 'K' ? 1024 : 1;
    return Math.round(n * mul);
  }

  /* ==========================================================
   * 9. 健康度（被动统计，供设置页展示）
   * ========================================================== */

  var health = Object.create(null);
  Object.keys(PROVIDERS).forEach(function (k) {
    health[k] = { ok: 0, fail: 0, lastMs: 0, lastErr: '', lastAt: 0 };
  });

  function track(id, promise) {
    var t0 = Date.now();
    return promise.then(function (v) {
      var h = health[id];
      if (h) { h.ok++; h.lastMs = Date.now() - t0; h.lastAt = Date.now(); h.lastErr = ''; }
      return v;
    }, function (e) {
      var h = health[id];
      if (h) { h.fail++; h.lastMs = Date.now() - t0; h.lastAt = Date.now(); h.lastErr = (e && e.message) || 'error'; }
      throw e;
    });
  }

  /* ==========================================================
   * 10. raceWeighted —— 分档并发竞速
   * ----------------------------------------------------------
   * 全部任务同时发车：
   *   · 无损档(0)先到 → 立刻采用
   *   · 低档先到 → 记为候选，开一个宽限窗口等无损
   *   · 宽限窗口到点或全部结束 → 用当前最佳候选
   * ========================================================== */

  function raceWeighted(tasks, opt) {
    opt = opt || {};
    var grace = opt.grace != null ? opt.grace : settings.graceMs;
    var hard = opt.timeout || settings.hardTimeout;

    return new Promise(function (resolve, reject) {
      var best = null, bestScore = -1;
      var pending = tasks.length;
      var settled = false;
      var graceTimer = null;
      var errs = [];

      if (!pending) return reject(new Error('无可用音源'));

      var hardTimer = setTimeout(function () { finish(); }, hard);

      function rank(r) {
        // 档位优先，同档看权重
        return (10 - (r.tier || 0)) * 1000 + (r.weight || 0);
      }

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(graceTimer);
        if (best) resolve(best);
        else reject(new Error(errs[0] || '全部音源均不可用'));
      }

      tasks.forEach(function (t) {
        var p;
        try { p = Promise.resolve(t.run()); }
        catch (e) { p = Promise.reject(e); }

        p.then(function (res) {
          if (settled || !res) return;
          res.tier = t.tier;
          res.weight = t.weight;
          res.provider = t.provider;
          var sc = rank(res);
          if (sc > bestScore) { bestScore = sc; best = res; }

          if (t.tier === TIER.LOSSLESS) {
            finish();                       // 无损到手，不等了
          } else if (!graceTimer) {
            graceTimer = setTimeout(finish, grace);
          }
        }, function (e) {
          errs.push((e && e.message) || 'err');
        }).then(function () {
          if (--pending <= 0) finish();
        });
      });
    });
  }

  /* ==========================================================
   * 11. 跨源取声：拿元数据到 JOOX 找同一首歌
   * ========================================================== */

  function crossMatch(want, providerId) {
    var P = PROVIDERS[providerId];
    if (!P || !P.caps.search) return Promise.reject(new Error('n/a'));

    var ck = 'xm:' + providerId + ':' + want.uid;
    var hit = cacheGet(ck);
    if (hit) return Promise.resolve(hit);

    // 两轮查询：先「歌名 歌手」，不行再只用歌名
    var q1 = want.name + ' ' + String(want.artist || '').split(/[\/、,，&]/)[0];
    var q2 = want.name;

    function pick(list) {
      var bestT = null, bestS = 0;
      for (var i = 0; i < list.length; i++) {
        var s = scoreMatchV2(want, list[i]);
        if (s > bestS) { bestS = s; bestT = list[i]; }
        if (s >= MATCH_STRONG) break;
      }
      return { track: bestT, score: bestS };
    }

    return track(providerId, P.search(q1, 1, 20)).then(function (list) {
      var r = pick(list || []);
      if (r.score >= MATCH_ACCEPT) return r;
      return track(providerId, P.search(q2, 1, 25)).then(function (l2) {
        var r2 = pick(l2 || []);
        return r2.score > r.score ? r2 : r;
      }, function () { return r; });
    }).then(function (r) {
      if (!r.track || r.score < MATCH_ACCEPT) throw new Error('未匹配到同源曲目');
      cacheSet(ck, r, META_TTL);
      return r;
    });
  }

  /* ==========================================================
   * 12. 对外 API
   * ========================================================== */

  /** 平台 → 该平台的搜索源顺序 */
  // 动态推导：返回所有声明了 search 能力的 provider，按 weight 降序。
  // 纯前端无内置源，platform 参数仅作提示，不再写死到具体服务。
  function searchPlan(platform) {
    var ids = Object.keys(PROVIDERS).filter(function (k) {
      return PROVIDERS[k].caps && PROVIDERS[k].caps.search;
    });
    ids.sort(function (a, b) { return (PROVIDERS[b].weight || 0) - (PROVIDERS[a].weight || 0); });
    return ids;
  }

  function dedupe(list) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var k = t.platform + '|' + normalizeTitle(t.name) + '|' + normalizeArtist(t.artist);
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(t);
    }
    return out;
  }

  var Sources = {

    TIER: TIER,
    PROVIDERS: PROVIDERS,

    settings: settings,
    configure: function (patch) {
      for (var k in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, k)) settings[k] = patch[k];
      }
      // 兼容设置面板「自定义源」输入框：customSource.{searchUrl,urlUrl}
      // 统一映射到 settings.customSearch / settings.customUrl
      if (patch.customSource) {
        if (patch.customSource.searchUrl) settings.customSearch = patch.customSource.searchUrl;
        if (patch.customSource.urlUrl) settings.customUrl = patch.customSource.urlUrl;
      }
      return settings;
    },

    /** 注册单个自定义音源。def 需包含 id / label / tier / weight / caps 及对应方法。
     *  caps 支持：search / url / lyric / pic / playlist / toplist / lossless
     *  例：Sources.registerProvider({ id:'my-joox', label:'我的JOOX', tier:TIER.LOSSLESS,
     *        weight:100, caps:{search:1,url:1,lossless:1,lyric:1},
     *        search:function(kw){...}, url:function(t,br){...}, lyric:function(t){...} }); */
    registerProvider: function (def) {
      if (!def || !def.id) throw new Error('provider 必须包含 id');
      if (!def.caps) def.caps = {};
      PROVIDERS[def.id] = def;
      health[def.id] = { ok: 0, fail: 0, lastMs: 0, lastErr: '', lastAt: 0 };
      return Sources;
    },

    /** 批量注册 */
    registerProviders: function (arr) {
      (arr || []).forEach(function (d) { Sources.registerProvider(d); });
      return Sources;
    },

    /** 列出当前已注册（含内置 custom）的所有音源定义 */
    listProviders: function () {
      return Object.keys(PROVIDERS).map(function (k) { return PROVIDERS[k]; });
    },

    /* ---------- 搜索 ---------- */
    search: function (platform, keyword, page, limit) {
      keyword = String(keyword || '').trim();
      if (!keyword) return Promise.resolve([]);
      page = page || 1;
      limit = limit || 30;

      var ck = 'q:' + platform + ':' + keyword + ':' + page + ':' + limit;
      var hit = cacheGet(ck);
      if (hit) return Promise.resolve(hit);

      var plan = searchPlan(platform);

      if (platform === 'all') {
        // 并发跑所有 search-capable provider，交叉合并去重
        var ids = searchPlan('all');
        if (!ids.length) return Promise.resolve([]);
        return Promise.all(ids.map(function (pid) {
          var P = PROVIDERS[pid];
          return track(pid, Promise.resolve(P.search(keyword, page, limit, 'all')))
            .then(function (list) { return list || []; }, function () { return []; });
        })).then(function (rs) {
          var out = [];
          rs.forEach(function (arr) { (arr || []).forEach(function (t) { out.push(t); }); });
          out = dedupe(out);
          cacheSet(ck, out, 5 * 60 * 1000);
          return out;
        });
      }

      // 单平台：按计划串行降级（搜索要保证结果顺序稳定，不做竞速）
      var idx = 0;
      function next() {
        if (idx >= plan.length) return Promise.resolve([]);
        var pid = plan[idx++];
        var P = PROVIDERS[pid];
        if (!P || !P.caps.search) return next();
        return track(pid, Promise.resolve(P.search(keyword, page, limit, platform)))
          .then(function (list) {
            if (!list || !list.length) return next();
            return list;
          }, function () { return next(); });
      }

      return next().then(function (list) {
        list = dedupe(list || []);
        if (list.length) cacheSet(ck, list, 5 * 60 * 1000);
        return list;
      });
    },

    /* ---------- 解析播放地址（核心） ---------- */
    resolveUrl: function (trackObj, opt) {
      opt = opt || {};
      var self = this;
      var br = opt.br || settings.quality || 999;
      var wantLossless = br >= 700 && settings.preferLossless;

      var ck = 'u:' + trackObj.uid + ':' + br;
      var hit = cacheGet(ck) || lsCacheGet(ck);
      if (hit && !opt.force) return Promise.resolve(hit);

      var tasks = [];

      /* --- A. 本源直取（动态：取该 track 来源 provider 的 url 能力，custom 作兜底） --- */
      var nativePlan = [];
      var sp = PROVIDERS[trackObj.source];
      if (sp && sp.caps && sp.caps.url) nativePlan.push(sp.id);
      if (settings.customUrl && (!sp || sp.id !== 'custom')) nativePlan.unshift('custom');

      nativePlan.forEach(function (pid) {
        var P = PROVIDERS[pid];
        if (!P || !P.caps.url) return;
        tasks.push({
          provider: pid,
          tier: P.tier,
          weight: P.weight,
          run: function () {
            return track(pid, Promise.resolve(P.url(trackObj, br))).then(function (r) {
              if (!r || !r.url) return null;
              return {
                url: r.url,
                br: r.br || 0,
                size: r.size || 0,
                via: pid,
                viaLabel: P.label,
                matched: null,
                duration: r.duration || trackObj.duration
              };
            });
          }
        });
      });

      /* --- 跨源取无损：若开启 crossMatch，用声明 lossless 能力的最优 provider 试匹配 --- */
      if (settings.crossMatch && wantLossless) {
        var best = null;
        Object.keys(PROVIDERS).forEach(function (k) {
          var P = PROVIDERS[k];
          if (P.id === trackObj.source) return;
          if (!(P.caps && P.caps.url && P.caps.lossless && P.caps.search)) return;
          if (!best || (P.weight || 0) > (best.weight || 0)) best = P;
        });
        if (best) {
          tasks.push({
            provider: best.id,
            tier: best.tier,
            weight: (best.weight || 0) - 5,
            run: function () {
              return crossMatch(trackObj, best.id).then(function (m) {
                return track(best.id, best.url(m.track, br)).then(function (r) {
                  if (!r || !r.url) return null;
                  return {
                    url: r.url, br: r.br || 0, size: r.size || 0,
                    via: best.id, viaLabel: best.label,
                    matched: { track: m.track, score: Math.round(m.score) },
                    duration: m.track.duration || trackObj.duration
                  };
                }, function () { return null; });
              }, function () { return null; });
            }
          });
        }
      }

      return raceWeighted(tasks, { grace: opt.grace, timeout: opt.timeout })
        .then(function (res) {
          var dur = res.duration || trackObj.duration || 0;
          var q = inferQuality(res.url, res.size, dur, res.br);
          var out = {
            url: res.url,
            via: res.via,
            viaLabel: res.viaLabel,
            matched: res.matched,
            quality: q,
            tier: res.tier,
            duration: dur,
            at: Date.now()
          };
          cacheSet(ck, out, URL_TTL);
          lsCacheSet(ck, out, URL_TTL);
          return out;
        });
    },

    /* ---------- 歌词（含翻译） ---------- */
    lyric: function (trackObj) {
      var ck = 'l:' + trackObj.uid;
      var hit = cacheGet(ck);
      if (hit) return Promise.resolve(hit);

      // 动态推导：所有声明 lyric 能力的 provider
      var plan = Object.keys(PROVIDERS).filter(function (k) {
        return PROVIDERS[k].caps && PROVIDERS[k].caps.lyric;
      });

      var idx = 0;
      function next() {
        if (idx >= plan.length) {
          return Promise.resolve({ lyric: '', tlyric: '' });
        }
        var pid = plan[idx++];
        var P = PROVIDERS[pid];
        if (!P || !P.caps.lyric) return next();
        return track(pid, Promise.resolve(P.lyric(trackObj)))
          .then(function (r) {
            if (!r || !r.lyric) return next();
            r.via = pid;
            return r;
          }, function () { return next(); });
      }

      return next().then(function (r) {
        if (r && r.lyric) cacheSet(ck, r, META_TTL);
        return r;
      });
    },

    /** 跨源歌词：本源没歌词时，用匹配到的 JOOX/酷我 曲目再拿一次 */
    lyricCross: function (trackObj) {
      var self = this;
      return this.lyric(trackObj).then(function (r) {
        if (r && r.lyric) return r;
        var losslessIds = Object.keys(PROVIDERS).filter(function (k) {
          var P = PROVIDERS[k];
          return P.caps && P.caps.search && P.caps.lyric && P.caps.lossless;
        });
        var chain = Promise.reject(new Error('no cross source'));
        losslessIds.forEach(function (pid) {
          chain = chain.catch(function () {
            return crossMatch(trackObj, pid).then(function (m) { return self.lyric(m.track); });
          });
        });
        return chain.catch(function () { return { lyric: '', tlyric: '' }; });
      });
    },

    /* ---------- 封面 ---------- */
    picUrl: function (trackObj, size) {
      size = size || 300;
      if (trackObj.pic) return trackObj.pic;

      /* 合并曲目：若主音源无封面信息，从 sources 里借任意一条有封面的 */
      if (trackObj.sources && !trackObj.picId) {
        for (var k0 in trackObj.sources) {
          var alt = trackObj.sources[k0];
          if (alt && (alt.pic || alt.picId)) {
            trackObj = alt;
            break;
          }
        }
      }

      // 动态推导：所有声明 pic 能力的 provider
      var plan = Object.keys(PROVIDERS).filter(function (k) {
        return PROVIDERS[k].caps && PROVIDERS[k].caps.pic;
      });

      for (var i = 0; i < plan.length; i++) {
        var P = PROVIDERS[plan[i]];
        if (!P || !P.caps.pic) continue;
        try {
          var u = P.pic(trackObj, size);
          if (u) return u;
        } catch (e) {}
      }
      return '';
    },

    /* ---------- 歌单导入 ---------- */
    playlist: function (server, id) {
      var ids = Object.keys(PROVIDERS).filter(function (k) {
        return PROVIDERS[k].caps && PROVIDERS[k].caps.playlist;
      });
      if (!ids.length) return Promise.reject(new Error('未配置歌单音源：请在 sources.config.js 注册支持 playlist 的 provider'));
      return track(ids[0], PROVIDERS[ids[0]].playlist(server, id));
    },

    /** 从各种分享链接里抠出 歌单 id */
    parsePlaylistInput: function (input) {
      var s = String(input || '').trim();
      if (!s) return null;
      if (/^\d+$/.test(s)) return { server: 'netease', id: s };

      var m;
      if ((m = /music\.163\.com[^]*?[?&#/]id=(\d+)/.exec(s))) return { server: 'netease', id: m[1] };
      // 路径式分享：music.163.com/playlist/924680166/share、/#/m/playlist/123
      if ((m = /music\.163\.com[^]*?\/playlist\/(\d+)/.exec(s))) return { server: 'netease', id: m[1] };
      if ((m = /163cn\.tv/.exec(s))) return null;   // 短链需跳转，前端拿不到
      if ((m = /playlist[/?&]id=(\d+)/.exec(s)))    return { server: 'netease', id: m[1] };
      if ((m = /y\.qq\.com[^]*?playlist\/(\w+)/.exec(s)))  return { server: 'tencent', id: m[1] };
      if ((m = /y\.qq\.com[^]*?[?&]id=(\w+)/.exec(s)))     return { server: 'tencent', id: m[1] };
      if ((m = /i\.y\.qq\.com[^]*?[?&]id=(\w+)/.exec(s)))  return { server: 'tencent', id: m[1] };
      // 泛化兜底：任意链接里出现 playlist/<数字> 视为网易云
      if ((m = /playlist\/(\d{5,})/.exec(s)))       return { server: 'netease', id: m[1] };
      return null;
    },

    /* ---------- 排行榜 ---------- */
    toplist: function (platform, id) {
      var ids = Object.keys(PROVIDERS).filter(function (k) {
        return PROVIDERS[k].caps && PROVIDERS[k].caps.toplist;
      });
      if (!ids.length) return Promise.reject(new Error('未配置排行榜音源：请在 sources.config.js 注册支持 toplist 的 provider'));
      return track(ids[0], PROVIDERS[ids[0]].toplist(id || 4));
    },

    /* ---------- QQ 歌单详情（公开接口；只认 jsonpCallback，不接受 callback/format=jsonp，需专用加载） ---------- */
    qqPlaylist: function (dissid) {
      var cbName = '__mh_pl_' + (Date.now().toString(36)) + '_' + (jsonpSeq++);
      var u = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_playlist_cp.fcg?id=' + enc(dissid) +
              '&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq&needNewCode=0' +
              '&jsonpCallback=' + cbName;
      return new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        var done = false;
        var timer = setTimeout(function () { finish(new Error('jsonp timeout')); }, 10000);
        function finish(err, data) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { delete global[cbName]; } catch (e) { global[cbName] = undefined; }
          if (s.parentNode) s.parentNode.removeChild(s);
          err ? reject(err) : resolve(data);
        }
        global[cbName] = function (data) { finish(null, data); };
        s.onerror = function () { finish(new Error('jsonp network')); };
        s.src = u;
        s.charset = 'utf-8';
        (document.head || document.documentElement).appendChild(s);
      }).then(function (r) {
        var cd = r && r.data && r.data.cdlist && r.data.cdlist[0];
        if (!cd || !cd.songlist || !cd.songlist.length) throw new Error('qq playlist empty');
        var name = String(cd.dissname || '').trim();
        var list = cd.songlist.map(function (x) {
          var singer = (x.singer || []).map(function (s) { return s.name; }).join(' / ');
          return mkTrack({
            platform: 'tencent',
            id: x.songmid || x.songid || x.id,
            name: x.songname || x.name,
            artist: singer,
            album: x.albumname || (x.album && x.album.name) || '',
            duration: Number(x.interval) || 0,
            picId: x.albummid || (x.album && x.album.mid) || '',
            lyricId: x.songmid,
            urlId: x.songmid,
            source: 'qq-official',
            raw: x
          });
        });
        return { name: name, list: list };
      });
    },

    /* ---------- 下载 ---------- */
    download: function (trackObj, onProgress) {
      var self = this;
      return this.resolveUrl(trackObj).then(function (r) {
        var name = (trackObj.artist + ' - ' + trackObj.name)
          .replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        var ext = r.quality.format || 'mp3';

        return fetch(r.url, { mode: 'cors', credentials: 'omit' }).then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          var total = Number(resp.headers.get('content-length')) || r.quality.size || 0;
          if (!resp.body || !onProgress) return resp.blob();

          var reader = resp.body.getReader();
          var chunks = [], got = 0;
          return (function pump() {
            return reader.read().then(function (res) {
              if (res.done) return new Blob(chunks);
              chunks.push(res.value);
              got += res.value.length;
              if (total) onProgress(got / total, got, total);
              return pump();
            });
          })();
        }).then(function (blob) {
          var a = document.createElement('a');
          var href = URL.createObjectURL(blob);
          a.href = href;
          a.download = name + '.' + ext;
          document.body.appendChild(a);
          a.click();
          setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(href);
          }, 1500);
          return { name: a.download, size: blob.size, quality: r.quality };
        });
      });
    },

    /* ---------- 匹配工具外露（UI 展示用） ---------- */
    scoreMatch: scoreMatchV2,
    normalizeTitle: normalizeTitle,
    t2s: t2s,
    inferQuality: inferQuality,
    probeAudio: probeAudio,

    /* ---------- 健康度 ---------- */
    health: function () {
      return Object.keys(PROVIDERS).map(function (k) {
        var P = PROVIDERS[k], h = health[k];
        var total = h.ok + h.fail;
        return {
          id: k,
          label: P.label,
          note: P.note,
          tier: P.tier,
          caps: P.caps,
          ok: h.ok,
          fail: h.fail,
          rate: total ? Math.round(h.ok / total * 100) : -1,
          lastMs: h.lastMs,
          lastErr: h.lastErr,
          lastAt: h.lastAt
        };
      });
    },

    /** 主动体检：逐条源打一次真实请求 */
    diagnose: function (onEach) {
      var probe = mkTrack({
        platform: 'netease', id: '186016', name: '晴天', artist: '周杰伦',
        album: '叶惠美', duration: 269, lyricId: '186016', urlId: '186016'
      });
      var CAP = 8000;   // 单条源最长等待，防止某条源挂起拖死整个体检
      var ids = Object.keys(PROVIDERS).filter(function (pid) {
        // 未填写地址的自定义源不参与体检，避免误报成「故障」
        return !(pid === 'custom' && !settings.customUrl && !settings.customSearch);
      });

      // 并行探测：每条独立超时兜底，结果按 PROVIDERS 顺序返回
      return Promise.all(ids.map(function (pid) {
        var P = PROVIDERS[pid];
        var t0 = Date.now();
        var job;
        try {
          if (P.caps.search)     job = Promise.resolve(P.search('晴天', 1, 3, 'netease'));
          else if (P.caps.lyric) job = Promise.resolve(P.lyric(probe));
          else                   job = Promise.reject(new Error('无可测能力'));
        } catch (e) {
          job = Promise.reject(e);
        }

        return Promise.race([job, timeout(CAP)]).then(function (r) {
          var n = Array.isArray(r) ? r.length : -1;
          var item = {
            id: pid, label: P.label,
            ok: n !== 0,                                   // 返回 0 条视为不可用
            ms: Date.now() - t0,
            detail: n >= 0 ? (n + ' 条') : '正常'
          };
          if (n === 0) item.detail = '无结果';
          onEach && onEach(item);
          return item;
        }, function (e) {
          var msg = (e && e.message) || '失败';
          if (/timeout/i.test(msg)) msg = '超时 ' + (CAP / 1000) + 's';

          // 搜索挂了不代表整条源废了：回退测一次直链解析能力
          if (P.caps.url && typeof P.url === 'function') {
            var t1 = Date.now();
            return Promise.race([
              Promise.resolve().then(function () { return P.url(probe, 999); }),
              timeout(CAP)
            ]).then(function (r) {
              var item = {
                id: pid, label: P.label, ok: true, ms: Date.now() - t1,
                detail: '仅解析可用' + (r && r.br ? ' · ' + r.br + 'k' : '')
              };
              onEach && onEach(item);
              return item;
            }, function () {
              var item = { id: pid, label: P.label, ok: false, ms: Date.now() - t0, detail: msg };
              onEach && onEach(item);
              return item;
            });
          }

          var item = {
            id: pid, label: P.label, ok: false,
            ms: Date.now() - t0, detail: msg
          };
          onEach && onEach(item);
          return item;
        });
      }));
    },

    clearCache: function () {
      MEM = Object.create(null);
      try { localStorage.removeItem(LS_KEY); } catch (e) {}
    }
  };

  global.Sources = Sources;

})(window);
