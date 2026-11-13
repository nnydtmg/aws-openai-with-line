import "source-map-support/register"
import serverlessExpress from "@vendia/serverless-express"
import { randomUUID } from "crypto"
import express, { ErrorRequestHandler } from "express"
import {
  JSONParseError,
  messagingApi,
  middleware,
  SignatureValidationFailed,
  webhook,
} from "@line/bot-sdk"
import OpenAI from "openai"
import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb"
import dayjs from "dayjs"
import utc from "dayjs/plugin/utc"
import advancedFormat from "dayjs/plugin/advancedFormat"

dayjs.extend(utc)
dayjs.extend(advancedFormat)

const nanoSecondFormat = "YYYY-MM-DDTHH:mm:ss.SSSSSSSSS[Z]"

const messagesTableName = "messages"

const ddbDocClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "ap-northeast-1",
  })
)

const lineBotClient = new messagingApi.MessagingApiClient({
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN ?? "",
})

const openAi = new OpenAI({
  apiKey: process.env.OPEN_AI_SECRET ?? "",
})

const handleEvent = async (event: webhook.Event) => {
  if (
    event.type !== "message" ||
    event.message.type !== "text" ||
    !event.replyToken ||
    !event.source?.userId
  ) {
    return null
  }

  const userId = event.source.userId
  const userMessageContent = event.message.text
  // ユーザの発言履歴を保存する
  await ddbDocClient.send(
    new PutCommand({
      TableName: messagesTableName,
      Item: {
        id: randomUUID(),
        content: userMessageContent,
        userId: userId,
        typedAt: dayjs().format(nanoSecondFormat),
        role: "user",
      },
    })
  )

  // 会話中ユーザのこれまでの発言履歴を取得する
  const { Items: messages = [] } = await ddbDocClient.send(
    new QueryCommand({
      TableName: messagesTableName,
      IndexName: "userIdIndex",
      KeyConditionExpression: "#userId = :userId",
      ExpressionAttributeNames: {
        "#userId": "userId",
      },
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    })
  )

  // 時系列順にソートする（typedAt は固定長の ISO 8601 文字列なので文字列比較でよい）
  const queriedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [...messages]
    .sort((a, b) => (a.typedAt < b.typedAt ? -1 : a.typedAt > b.typedAt ? 1 : 0))
    .map(
      (message) =>
        ({
          role: message.role,
          content: message.content,
        } as OpenAI.Chat.ChatCompletionMessageParam)
    )

  // ユーザとChatGPTの会話履歴をChatGPT APIに投げ、返答を得る
  const completion = await openAi.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [
      {
        role: "system",
        content:
          "質問したことに対して、英語と日本語の両方で返事をしてください。"
      },
      ...queriedMessages,
    ],
  })

  const chatGptMessageContent = completion.choices[0]?.message?.content
  if (!chatGptMessageContent) {
    throw new Error("OpenAI API returned an empty message")
  }
  // ChatGPTの発言を保存する
  await ddbDocClient.send(
    new PutCommand({
      TableName: messagesTableName,
      Item: {
        id: randomUUID(),
        content: chatGptMessageContent,
        userId: userId,
        typedAt: dayjs().format(nanoSecondFormat),
        role: "assistant",
      },
    })
  )

  // ChatGPTの発言をパラメータにLINE MessagingAPIを叩く
  const repliedMessage: messagingApi.TextMessage = {
    type: "text",
    text: chatGptMessageContent,
  }
  return lineBotClient.replyMessage({
    replyToken: event.replyToken,
    messages: [repliedMessage],
  })
}

const app = express()
// CHANNEL_SECRET が未設定だと空の鍵で署名を検証することになり、誰でも署名を偽造できる。
// 未設定の場合は全リクエストを拒否する（フェイルクローズ）。
app.use((_req, res, next) => {
  if (!process.env.CHANNEL_SECRET) {
    console.error("CHANNEL_SECRET is not configured")
    return res.status(500).end()
  }
  return next()
})
app.use(
  // 署名検証+JSONパースのミドルウェア。
  // すべてのルートより前に置くことで、どのパスへのリクエストも署名検証を通過しないと処理されない。
  middleware({
    channelSecret: process.env.CHANNEL_SECRET ?? "",
  })
)

app.post("/webhook", async (req, res) => {
  try {
    const events: webhook.Event[] = req.body.events ?? []

    const results = await Promise.all(events.map(handleEvent))
    return res.json(results)
  } catch (err) {
    console.error(err)
    return res.status(500).end()
  }
})

// 署名検証・JSON パースの失敗はスタックトレースを返さずに 4xx で拒否する
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof SignatureValidationFailed) {
    return res.status(401).end()
  }
  if (err instanceof JSONParseError) {
    return res.status(400).end()
  }
  console.error(err)
  return res.status(500).end()
}
app.use(errorHandler)

export default app

export const handler = serverlessExpress({ app })