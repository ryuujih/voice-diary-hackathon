require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS設定
app.use(cors({
    origin: [
        'https://your-frontend-domain.com',  // 実際のフロントエンドドメインに変更
        'http://localhost:3000',
        'https://localhost:3000'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// アップロードディレクトリ
const uploadDir = '/tmp/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ 
    dest: uploadDir,
    limits: { fileSize: 10 * 1024 * 1024 }
});

let speechClient, vertexAI, generativeModel, isGCPConfigured = false;
let chatSessions = new Map();

async function initializeGCP() {
    try {
        console.log('GCP初期化を開始...');
        
        // 環境変数の柔軟な確認
        const projectId = process.env.GOOGLE_CLOUD_PROJECT;
        if (!projectId) {
            console.warn('GOOGLE_CLOUD_PROJECT環境変数が未設定 - デモモードで起動');
            isGCPConfigured = false;
            return;
        }

        const { SpeechClient } = require('@google-cloud/speech');
        const { VertexAI } = require('@google-cloud/vertexai');

        speechClient = new SpeechClient({
            projectId: projectId
        });

        vertexAI = new VertexAI({
            project: projectId,
            location: 'us-central1',
        });

        generativeModel = vertexAI.preview.getGenerativeModel({
            model: 'gemini-2.0-flash',
            generationConfig: {
                maxOutputTokens: 1000,
                temperature: 0.7,
                topP: 0.8,
                topK: 40,
            },
        });

        // 接続テスト
        console.log('Vertex AI接続テスト中...');
        await generativeModel.generateContent('テスト');
        console.log('Vertex AI接続テスト成功');

        isGCPConfigured = true;
        console.log('GCP クライアント初期化完了');
        
    } catch (error) {
        console.error('GCP初期化エラー:', error.message);
        console.log('デモモードで起動');
        isGCPConfigured = false;
    }
}

// 統一されたヘルスチェック
app.get(['/health', '/api/health'], (req, res) => {
    res.json({ 
        status: 'OK',
        timestamp: new Date().toISOString(),
        services: {
            speechToText: isGCPConfigured ? 'gcp_api' : 'demo_mode',
            textGeneration: isGCPConfigured ? 'gcp_api' : 'demo_mode'
        },
        gcpConfigured: isGCPConfigured,
        projectId: process.env.NODE_ENV === 'production' 
            ? (process.env.GOOGLE_CLOUD_PROJECT ? 'configured' : 'not_configured')
            : (process.env.GOOGLE_CLOUD_PROJECT || 'not_configured'),
        activeSessions: chatSessions.size
    });
});

// チャット開始
app.post('/api/chat/start', (req, res) => {
    const sessionId = Date.now().toString();
    chatSessions.set(sessionId, {
        id: sessionId,
        messages: [],
        startTime: new Date(),
        status: 'active'
    });
    
    res.json({
        success: true,
        sessionId: sessionId,
        message: "こんにちは！今日はどんなことがありましたか？音声またはテキストで自由にお話しください。"
    });
});

// 音声認識
app.post('/api/speech-to-text', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'オーディオファイルが提供されていません' });
        }

        console.log('音声ファイル受信:', req.file.size, 'bytes');

        if (isGCPConfigured && speechClient) {
            try {
                const audioBytes = fs.readFileSync(req.file.path).toString('base64');

                const request = {
                    audio: { content: audioBytes },
                    config: {
                        encoding: 'WEBM_OPUS',
                        sampleRateHertz: 48000,
                        languageCode: 'ja-JP',
                        model: 'latest_short',
                        useEnhanced: true,
                    },
                };

                console.log('GCP Speech-to-Text API 呼び出し中...');
                const [response] = await speechClient.recognize(request);
                
                if (response.results && response.results.length > 0) {
                    const transcription = response.results
                        .map(result => result.alternatives[0].transcript)
                        .join('\n');
                    
                    const confidence = response.results[0]?.alternatives[0]?.confidence || 0;
                    
                    if (!transcription.trim() || transcription.trim().length < 2) {
                        throw new Error('音声認識結果が空です');
                    }
                    
                    console.log('音声認識成功:', transcription);
                    fs.unlinkSync(req.file.path);

                    res.json({ 
                        success: true, 
                        transcript: transcription,
                        confidence: confidence,
                        mode: 'gcp'
                    });
                    return;
                } else {
                    throw new Error('音声認識結果が空です');
                }
            } catch (apiError) {
                console.error('GCP Speech API エラー:', apiError.message);
                // GCP失敗時はデモモードにフォールバック
            }
        }
        
        // デモモード
        console.log('デモモードで音声認識をシミュレート');
        fs.unlinkSync(req.file.path);
        
        // ファイルサイズに基づいて適切なデモ応答を生成
        const fileSizeKB = req.file.size / 1024;
        
        if (fileSizeKB < 1) {
            return res.status(400).json({ 
                success: false,
                error: '音声が検出されませんでした。もう少し長く話してください。',
                mode: 'demo'
            });
        } else if (fileSizeKB > 500) {
            return res.status(400).json({ 
                success: false,
                error: '音声が長すぎます。60秒以内で話してください。',
                mode: 'demo'
            });
        }

        return res.status(400).json({ 
            success: false,
            error: 'デモモードでは音声認識は利用できません。',
            mode: 'demo'
        });

        res.json({ 
            success: true, 
            transcript: demoTranscript,
            confidence: 0.85,
            mode: 'demo'
        });

    } catch (error) {
        console.error('Speech-to-Text エラー:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ 
            error: '音声認識処理中にエラーが発生しました',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined 
        });
    }
});

// チャット対話
app.post('/api/chat/message', async (req, res) => {
    let session;
    console.log('=== Chat Message Request ===');
    console.log('Headers:', req.headers);
    console.log('Body:', req.body);
    console.log('Session exists:', chatSessions.has(req.body?.sessionId));
    console.log('GCP configured:', isGCPConfigured);
    
    try {
        const { sessionId, message } = req.body;
        
        if (!chatSessions.has(sessionId)) {
            return res.status(400).json({ error: 'セッションが見つかりません' });
        }
        
        session = chatSessions.get(sessionId);
        session.messages.push({
            role: 'user',
            content: message,
            timestamp: new Date()
        });
        
        console.log(`ユーザーメッセージ [${sessionId}]:`, message.substring(0, 50) + '...');

        if (isGCPConfigured && generativeModel) {
            try {
                const messageCount = session.messages.filter(msg => msg.role === 'user').length;
                
                // 感情分析とコンテキスト分析の追加
                const emotionAnalysis = analyzeUserEmotion(message);
                const conversationContext = getConversationContext(session.messages);
                
                let prompt = generateAdaptivePrompt(messageCount, message, emotionAnalysis, conversationContext, session);

                console.log(`適応的質問生成中... (メッセージ${messageCount}回目, 感情: ${emotionAnalysis.type})`);
                const result = await generativeModel.generateContent(prompt);
                const response = await result.response;
                const aiResponse = response.candidates[0].content.parts[0].text.trim();

                session.messages.push({
                    role: 'assistant',
                    content: aiResponse,
                    timestamp: new Date()
                });

                chatSessions.set(sessionId, session);

                console.log(`AI返答 [${sessionId}]:`, aiResponse);

                res.json({
                    success: true,
                    response: aiResponse,
                    messageCount: session.messages.length,
                    canSummarize: messageCount >= 3,
                    mode: 'gcp_improved'
                });

            } catch (apiError) {
                console.error('チャットAI エラー:', apiError.message);
                throw apiError;
            }
        } else {
            // デモモード（改善版）
            const messageCount = session.messages.filter(msg => msg.role === 'user').length;
            const emotionAnalysis = analyzeUserEmotion(message);
            
            const adaptiveResponses = generateDemoResponses(messageCount, emotionAnalysis);
            const responseIndex = Math.min(messageCount - 1, adaptiveResponses.length - 1);
            const aiResponse = adaptiveResponses[responseIndex];
            
            session.messages.push({
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date()
            });

            res.json({
                success: true,
                response: aiResponse,
                messageCount: session.messages.length,
                canSummarize: messageCount >= 3,
                mode: 'demo_improved'
            });
        }

    } catch (error) {
        console.error('チャット処理エラー:', error);
        
        // デモモードフォールバック
        const messageCount = session?.messages?.filter(msg => msg.role === 'user').length || 1;
        const fallbackResponses = [
            "今日はどんな一日でしたか？",
            "その時はどんな気持ちでしたか？",
            "他にも印象に残ったことはありますか？",
            "お話を聞かせていただき、ありがとうございました。日記にまとめてみませんか？"
        ];
        
        const responseIndex = Math.min(messageCount - 1, fallbackResponses.length - 1);
        
        res.json({
            success: true,
            response: fallbackResponses[responseIndex],
            messageCount: messageCount * 2,
            canSummarize: messageCount >= 3,
            mode: 'demo_fallback_improved'
        });
    }
});

// 感情分析関数
function analyzeUserEmotion(message) {
    const emotionKeywords = {
        positive: ['楽しい', '嬉しい', '良かった', '素晴らしい', '幸せ', '満足', '素敵', '最高'],
        negative: ['辛い', '悲しい', '困った', 'イライラ', '疲れた', '大変', '辛かった', 'ストレス'],
        neutral: ['普通', '特に', 'いつも通り', '普段通り', 'まあまあ']
    };
    
    const lowerMessage = message.toLowerCase();
    
    for (const [emotion, keywords] of Object.entries(emotionKeywords)) {
        if (keywords.some(keyword => lowerMessage.includes(keyword))) {
            return { type: emotion, confidence: 0.8 };
        }
    }
    
    return { type: 'neutral', confidence: 0.5 };
}

// 会話コンテキスト分析
function getConversationContext(messages) {
    const recentMessages = messages.slice(-4);
    const topics = [];
    const emotions = [];
    
    recentMessages.forEach(msg => {
        if (msg.role === 'user') {
            topics.push(extractMainTopic(msg.content));
            emotions.push(analyzeUserEmotion(msg.content));
        }
    });
    
    return { topics, emotions, flowState: 'continuing' };
}

// 簡単なトピック抽出
function extractMainTopic(content) {
    const topicKeywords = ['仕事', '家族', '友達', '勉強', '趣味', '買い物', '食事', '旅行', '運動', '映画'];
    return topicKeywords.find(topic => content.includes(topic)) || 'general';
}

// 適応的プロンプト生成
function generateAdaptivePrompt(messageCount, currentMessage, emotionAnalysis, context, session) {
    const emotionResponse = {
        positive: '喜びを共有し、その体験をより詳しく聞く',
        negative: '共感と理解を示し、優しく寄り添う口調で',
        neutral: '自然に関心を示し、相手が話しやすい雰囲気で'
    };

    const baseRules = `
応答のルール：
- 50文字以内の自然で親しみやすい口調
- ${emotionResponse[emotionAnalysis.type]}
- 相手のペースに合わせ、プレッシャーを与えない
- 人間らしい温かみのある反応
`;

    if (messageCount === 1) {
        return `
ユーザーが「${currentMessage}」と話しかけてきました。
現在の感情状態: ${emotionAnalysis.type}

この状況に適した自然な反応を生成してください：
${baseRules}
- 相手の話した具体的な内容に反応する
- 「今日は」という定型的な聞き方ではなく、相手の言葉を受けて自然に質問する
- 親近感のある口調で

応答:`;
    }
    
    const questionType = ((messageCount - 1) % 3) + 1;
    const previousMessage = session.messages.length >= 3 ? session.messages[session.messages.length - 3].content : '';
    
    if (questionType === 1) {
        return `
会話の流れ：
前回: 「${previousMessage}」
今回: 「${currentMessage}」
感情: ${emotionAnalysis.type}

この流れで自然に詳細を聞いてください：
${baseRules}
- 前の話との自然なつながりを意識
- 「具体的には？」ではなく、興味深い部分を掘り下げる質問
- 相手が話したくなるような聞き方

応答:`;
    }
    
    if (questionType === 2) {
        return `
これまでの話から、体験の深い部分を自然に聞き出してください：
現在の話: 「${currentMessage}」
感情状態: ${emotionAnalysis.type}

${baseRules}
- 感情を直接聞かず、体験や状況から感情が伝わるような質問
- 「どう感じましたか？」より「その時の状況は？」「印象的だったのは？」
- ${emotionAnalysis.type}な状態に寄り添った聞き方

応答:`;
    }
    
    // 話題の展開または締めくくり
    const cycleCount = Math.floor((messageCount - 1) / 3) + 1;
    if (cycleCount >= 3) {
        return `
十分な対話ができました。自然に日記作成を提案してください：
これまでの会話: ${session.messages.slice(-6).map(msg => msg.content).join(' ')}

${baseRules}
- 聞かせてもらったことへの感謝を表現
- 相手の体験を肯定的に受け止める言葉
- 日記作成への自然で前向きな提案

応答:`;
    } else {
        return `
現在の話題から自然に話を広げてください：
現在の内容: 「${currentMessage}」
会話の雰囲気: ${emotionAnalysis.type}

${baseRules}
- 急に話題を変えるのではなく、今の話から関連する内容を聞く
- 相手が無理なく答えられる範囲での質問
- 自然な会話の流れを保つ

応答:`;
    }
}

// デモモード用の適応的応答生成
function generateDemoResponses(messageCount, emotionAnalysis) {
    const responsesByEmotion = {
        positive: [
            "それは素晴らしいですね！どんな瞬間が一番印象的でしたか？",
            "いい体験でしたね。周りの反応はいかがでしたか？",
            "楽しそうな雰囲気が伝わってきます。他にも何か心に残ったことはありますか？",
            "今日は本当に充実した一日だったんですね。この素敵な思い出を日記にまとめてみませんか？"
        ],
        negative: [
            "お疲れ様でした。大変だったんですね。",
            "そういう時もありますよね。どんな風に乗り越えられましたか？",
            "辛い状況だったと思います。他に何かサポートはありましたか？",
            "いろいろなことがあった一日だったんですね。お話を聞かせていただき、ありがとうございました。日記にまとめてみませんか？"
        ],
        neutral: [
            "そうだったんですね。その時はどんな感じでしたか？",
            "なるほど。一番印象に残ったのはどの部分ですか？",
            "日常の中にも色々なことがありますね。他にも何かありましたか？",
            "お話を聞かせていただき、ありがとうございました。今日の一日を日記にまとめてみませんか？"
        ]
    };
    
    return responsesByEmotion[emotionAnalysis.type] || responsesByEmotion.neutral;
}

// タイトル生成エンドポイント
app.post('/api/generate-title', async (req, res) => {
    try {
        const { content } = req.body;
        
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ 
                success: false, 
                error: 'コンテンツが提供されていません' 
            });
        }

        console.log('タイトル生成開始:', content.substring(0, 100) + '...');

        if (isGCPConfigured && generativeModel) {
            try {
                const prompt = `以下の日記内容を読んで、シンプルで読みやすいタイトルを生成してください：

日記内容：
${content.substring(0, 500)}

要件：
- 12文字以内のシンプルなタイトル
- 日記の内容や感情を表現
- 記号や装飾文字は一切使用しない
- ひらがな、カタカナ、漢字、数字のみ使用
- 「〜な日」「〜の記録」「〜について」などの自然な形式
- マークダウン記法（**、*、_など）は使用禁止

例：
- 楽しい一日
- 新しい発見
- 忙しい日々
- 穏やかな時間

タイトルのみを出力してください：`;

                console.log('AI でタイトル生成中...');
                const result = await generativeModel.generateContent(prompt);
                const response = await result.response;
                let title = response.candidates[0].content.parts[0].text.trim();
                
                // 不要な文字を除去（より厳密に）
                title = title.replace(/[\*_`#\[\](){}|\\~]/g, ''); // マークダウン記法を除去
                title = title.replace(/^["「『]/, '').replace(/["」』]$/, ''); // 引用符除去
                title = title.replace(/^タイトル[：:]?/, '').trim(); // 「タイトル:」等を除去
                title = title.replace(/\.{2,}/g, ''); // 連続するドットを除去
                title = title.replace(/[…]/g, ''); // 三点リーダーを除去
                title = title.replace(/\s+/g, ''); // 余分な空白を除去
                
                // 長すぎる場合は短縮（装飾文字なしで）
                if (title.length > 12) {
                    title = title.substring(0, 12);
                }

                // 空の場合は日付ベースのフォールバック
                if (!title || title.length < 2) {
                    const now = new Date();
                    const month = now.getMonth() + 1;
                    const day = now.getDate();
                    title = `${month}月${day}日の日記`;
                }

                console.log('生成されたタイトル:', title);

                res.json({
                    success: true,
                    title: title,
                    mode: 'gcp'
                });

            } catch (apiError) {
                console.error('AI タイトル生成エラー:', apiError.message);
                throw apiError;
            }
        } else {
            // デモモード - シンプルなタイトル生成
            console.log('デモモードでタイトル生成');
            const keywords = ['楽しい', '嬉しい', '悲しい', '忙しい', '平和', '特別', '普通', '新しい', '大変'];
            const foundKeyword = keywords.find(keyword => content.includes(keyword));
            
            let title;
            if (foundKeyword) {
                title = `${foundKeyword}一日`;
            } else {
                const now = new Date();
                const month = now.getMonth() + 1;
                const day = now.getDate();
                title = `${month}月${day}日の記録`;
            }

            res.json({
                success: true,
                title: title,
                mode: 'demo'
            });
        }

    } catch (error) {
        console.error('タイトル生成エラー:', error);
        
        // フォールバック：日付ベースのタイトル
        const now = new Date();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const fallbackTitle = `${month}月${day}日の日記`;

        res.json({
            success: true,
            title: fallbackTitle,
            mode: 'fallback'
        });
    }
});

// チャット要約
app.post('/api/chat/summarize', async (req, res) => {
    let session;

    try {
        const { sessionId } = req.body;
        
        if (!chatSessions.has(sessionId)) {
            return res.status(400).json({ error: 'セッションが見つかりません' });
        }
        
        session = chatSessions.get(sessionId);
        const userMessages = session.messages.filter(msg => msg.role === 'user');
        
        console.log(`チャット要約開始 [${sessionId}]: ${userMessages.length}回の対話`);

        if (isGCPConfigured && generativeModel) {
            try {
                const prompt = `以下のユーザーとAIアシスタントの対話内容を基に、美しい日記としてまとめてください。

対話内容:
${session.messages.map(msg => `${msg.role === 'user' ? 'ユーザー' : 'AI'}: ${msg.content}`).join('\n')}

要求事項：
- 対話の内容を基に、自然な文章として構成してください
- 実際に話されていない内容は追加しないでください
- 日付や時間、感情の解釈などの勝手な補完は行わないでください
- ユーザーが話した具体的な内容と事実のみを使用してください
- 対話形式ではなく、まとまった文章として整理してください
- AIの質問部分は省略し、ユーザーの回答内容を中心にまとめてください
- 話された順序に従って内容を整理してください
- 改行は最小限に抑え、できるだけ連続した文章として出力してください 
- 段落分けは行わず、一つの流れのある文章として構成してください

日記：`;

                console.log('対話要約日記生成中...');
                const result = await generativeModel.generateContent(prompt);
                const response = await result.response;
                const summaryDiary = response.candidates[0].content.parts[0].text;

                session.status = 'completed';
                session.summary = summaryDiary;
                session.endTime = new Date();

                console.log('対話要約完了');

                res.json({
                    success: true,
                    diary: summaryDiary,
                    conversationCount: userMessages.length,
                    duration: Math.round((session.endTime - session.startTime) / 1000 / 60),
                    mode: 'gcp'
                });

            } catch (apiError) {
                console.error('要約生成エラー:', apiError.message);
                throw apiError;
            }
        } else {
            // デモモード
            const conversationText = userMessages.map(msg => msg.content).join(' ');
            const summaryDiary = `今日は心温まる一日を過ごすことができました。${conversationText.substring(0, 50)}...について振り返りながら、改めて日々の大切さを感じました。

対話を通じて自分の気持ちを整理することで、普段気づかない小さな幸せや感動に気づくことができました。こうした何気ない瞬間にこそ、生活の豊かさがあるのかもしれません。

明日もまた新しい発見や体験があることを楽しみにしながら、今日という日に感謝の気持ちを込めて、この日記を締めくくりたいと思います。`;

            session.status = 'completed';
            session.summary = summaryDiary;
            session.endTime = new Date();

            res.json({
                success: true,
                diary: summaryDiary,
                conversationCount: userMessages.length,
                duration: Math.round((session.endTime - session.startTime) / 1000 / 60),
                mode: 'demo'
            });
        }

    } catch (error) {
        console.error('要約処理エラー:', error);
        
        // デモモードフォールバック
        const session = chatSessions.get(req.body.sessionId);
        const userMessages = session ? session.messages.filter(msg => msg.role === 'user') : [];
        
        const fallbackDiary = `今日は特別な一日でした。様々な出来事があり、多くのことを感じ、考えることができました。

日々の小さな出来事の中にも、大切な意味や価値を見つけることができます。今日もそんな瞬間がいくつもありました。

これからも一日一日を大切に過ごしていきたいと思います。今日という日に感謝しながら。`;

        if (session) {
            session.status = 'completed';
            session.summary = fallbackDiary;
            session.endTime = new Date();
        }

        res.json({
            success: true,
            diary: fallbackDiary,
            conversationCount: userMessages.length,
            duration: session ? Math.round((session.endTime - session.startTime) / 1000 / 60) : 5,
            mode: 'demo_fallback'
        });
    }
});

// セッション一覧
app.get('/api/chat/sessions', (req, res) => {
    const sessions = Array.from(chatSessions.values()).map(session => ({
        id: session.id,
        status: session.status,
        messageCount: session.messages.length,
        startTime: session.startTime,
        endTime: session.endTime,
        hasSummary: !!session.summary
    }));
    
    res.json({ sessions });
});

// エラーハンドリング
app.use((error, req, res, next) => {
    console.error('サーバーエラー:', error);
    res.status(500).json({ 
        error: '内部サーバーエラーが発生しました',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
});

app.use((req, res) => {
    res.status(404).json({ error: 'エンドポイントが見つかりません' });
});

// グレースフルシャットダウン
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

function gracefulShutdown(signal) {
    console.log(`${signal} 受信: グレースフルシャットダウン開始`);
    
    try {
        if (fs.existsSync(uploadDir)) {
            const files = fs.readdirSync(uploadDir);
            files.forEach(file => {
                try {
                    fs.unlinkSync(`${uploadDir}/${file}`);
                } catch (err) {
                    console.warn('ファイル削除警告:', err.message);
                }
            });
        }
    } catch (err) {
        console.warn('クリーンアップ警告:', err.message);
    }
    
    process.exit(0);
}

// サーバー起動
async function startServer() {
    await initializeGCP();
    
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`音声日記帳APIサーバー起動`);
        console.log(`ポート: ${PORT}`);
        console.log(`モード: ${isGCPConfigured ? 'GCP API' : 'デモ'}`);
    });

    server.on('error', (err) => {
        console.error('サーバー起動エラー:', err);
        process.exit(1);
    });
}

startServer();
module.exports = app;