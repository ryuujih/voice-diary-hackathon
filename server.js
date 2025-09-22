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

// 音声認識（デモモード対応改善）
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
        
        // デモモード（改善版）
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
                
                let prompt;
                
                // インタビュアー風の構造的な質問パターン
                const questionType = ((messageCount - 1) % 3) + 1; // 1, 2, 3のループ
                const cycleCount = Math.floor((messageCount - 1) / 3) + 1; // 何周目か
                
                if (messageCount === 1) {
                    // 最初の質問：何があったかの確認
                    prompt = `ユーザーが日記作成のために話しかけてきました。インタビュアーのように、まず今日何があったかを聞いてください。

        ユーザーの発言: "${message}"

        応答のルール：
        - 50文字以内の短い応答
        - 共感を示す
        - 今日の出来事について具体的に聞く
        - インタビュアーのような聞き上手な口調

        応答:`;

                } else if (questionType === 1) {
                    // 詳細の深掘り
                    prompt = `前回の話について詳細を深掘りしてください。インタビュアーのように具体的な状況や背景を聞き出してください。

        これまでの会話:
        ${session.messages.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

        応答のルール：
        - 50文字以内の短い応答
        - 前回の話の詳細や背景を聞く
        - 「それはどんな感じでしたか」「具体的にはどのような」など
        - インタビュアーらしい掘り下げ方

        応答:`;

                } else if (questionType === 2) {
                    // 感情の確認
                    prompt = `その出来事に対する感情や印象を聞いてください。インタビュアーのように相手の内面を引き出してください。

        これまでの会話:
        ${session.messages.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

        応答のルール：
        - 50文字以内の短い応答
        - その時の気持ちや感情を聞く
        - 「どう感じましたか」「どんな気持ちでしたか」など
        - 共感的なインタビュアー口調

        応答:`;

                } else { // questionType === 3
                    // 他に何かあったかの確認（新しい話題）
                    if (cycleCount >= 3) {
                        // 3周目以降は日記作成を提案
                        prompt = `十分な情報が集まりました。インタビューを締めくくり、日記作成を提案してください。

        これまでの会話:
        ${session.messages.slice(-7).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

        応答のルール：
        - 60文字以内
        - 話を聞けたことに感謝
        - 日記作成の提案
        - インタビュアーらしい締めくくり

        応答:`;
                    } else {
                        // 他の話題を聞く
                        prompt = `他にも何か話題がないか聞いてください。インタビュアーのように新しい情報を引き出してください。

        これまでの会話:
        ${session.messages.slice(-5).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

        応答のルール：
        - 50文字以内の短い応答
        - 他の出来事や話題を聞く
        - 「他にも何かありましたか」「それ以外には」など
        - インタビュアーらしい話題転換

        応答:`;
                    }
                }

                console.log(`インタビュー質問生成中... (メッセージ${messageCount}回目, パターン${questionType}, 周回${cycleCount})`);
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
                    canSummarize: messageCount >= 1,
                    mode: 'gcp'
                });

            } catch (apiError) {
                console.error('チャットAI エラー:', apiError.message);
                throw apiError;
            }
        } else {
            // デモモード（改善版）
            const messageCount = session.messages.filter(msg => msg.role === 'user').length;
            const shortResponses = [
                "それは素敵ですね！どんな気持ちでしたか？",
                "いいですね。一番印象に残ったのは何ですか？",
                "なるほど。他にも何かありましたか？",
                "ありがとうございます。素敵なお話でした！日記を作成しましょうか？"
            ];
            
            const responseIndex = Math.min(messageCount - 1, shortResponses.length - 1);
            const aiResponse = shortResponses[responseIndex];
            
            session.messages.push({
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date()
            });

            res.json({
                success: true,
                response: aiResponse,
                messageCount: session.messages.length,
                canSummarize: messageCount >= 1,
                mode: 'demo'
            });
        }

    } catch (error) {
        console.error('チャット処理エラー:', error);
        
        // デモモードフォールバック
        const messageCount = session?.messages?.filter(msg => msg.role === 'user').length || 1;
        const fallbackResponses = [
            "申し訳ありません。今日はどんなことがありましたか？",
            "そうですね。もう少し詳しく教えてください。",
            "なるほど。他にも何かありましたか？",
            "ありがとうございます。日記を作成しましょう！"
        ];
        
        const responseIndex = Math.min(messageCount - 1, fallbackResponses.length - 1);
        
        res.json({
            success: true,
            response: fallbackResponses[responseIndex],
            messageCount: messageCount * 2,
            canSummarize: messageCount >= 1,
            mode: 'demo_fallback'
        });
    }
});

// タイトル生成エンドポイント（改善版）
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
            // デモモード（改善版）
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