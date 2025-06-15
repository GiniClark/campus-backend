const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const dotenv = require("dotenv");
const cors = require("cors"); // 引入cors
const redis = require("redis");
const axios = require("axios");

dotenv.config(); // 加载环境变量

const app = express();
const PORT = process.env.PORT || 3050;

// 创建一个Redis客户端
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379", // Redis连接地址
});

redisClient.on("error", (err) => console.log("Redis Client Error", err));
redisClient.connect().then(() => console.log("Redis Client Connected"));

// 中间件
app.use(express.json());
app.use(cors()); // 添加cors中间件，允许所有来源的请求
// app.use("/uploads", express.static("uploads")); // 提供静态文件访问

// //如果你只想允许特定的来源（如http://localhost:3000）访问后端，可以自定义CORS配置：
// app.use(
//     cors({
//       origin: "http://localhost:3000", // 只允许来自localhost:3000的请求
//       methods: ["GET", "POST"], // 允许的HTTP方法
//       allowedHeaders: ["Content-Type"], // 允许的请求头
//     })
//   );

// // 配置Multer存储
// const storage = multer.diskStorage({
//   destination: (req, file, cb) => {
//     cb(null, "uploads/"); // 文件存储目录
//   },
//   filename: (req, file, cb) => {
//     const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
//     cb(null, uniqueSuffix + path.extname(file.originalname));
//   },
// });
// const upload = multer({ storage });

// // 确保uploads目录存在
// const fs = require("fs");
// if (!fs.existsSync("uploads")) {
//   fs.mkdirSync("uploads");
// }

// 连接MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// // 定义文件模型
// const FileSchema = new mongoose.Schema({
//   filename: String,
//   path: String,
//   originalName: String,
//   mimeType: String,
//   size: Number,
//   uploadDate: { type: Date, default: Date.now },
// });
// const File = mongoose.model("File", FileSchema);

// 定义NFT模型
const NFTSchema = new mongoose.Schema({
  tokenId: Number,
  image: String,
  name: String,
  description: String,
  class: String,
  price: String,
  owner: String,
  uri: String,
  cid: String,
  fileCID: String, // 文件的 CID
  isListed: { type: Boolean, default: false }, // 新增字段，表示是否上架
});
const NFT = mongoose.model("NFT", NFTSchema);

// 定义用户信用评分模型
const CreditSchema = new mongoose.Schema({
  userAddress: String,
  score: Number,
});
const Credit = mongoose.model("Credit", CreditSchema);

// // 上传文件路由
// app.post("/upload", upload.single("file"), async (req, res) => {
//   try {
//     const file = req.file;
//     if (!file) {
//       return res.status(400).json({ error: "No file uploaded" });
//     }

//     // 保存文件信息到MongoDB
//     const newFile = new File({
//       filename: file.filename,
//       path: file.path,
//       originalName: file.originalname,
//       mimeType: file.mimetype,
//       size: file.size,
//     });
//     await newFile.save();

//     // 生成下载链接
//     const downloadUrl = `http://localhost:${PORT}/download/${file.filename}`;
//     res.json({ downloadUrl });
//   } catch (error) {
//     console.error("Upload error:", error);
//     res.status(500).json({ error: "Upload failed" });
//   }
// });

// // 下载文件路由
// app.get("/download/:filename", async (req, res) => {
//   try {
//     const file = await File.findOne({ filename: req.params.filename });
//     if (!file) {
//       return res.status(404).json({ error: "File not found" });
//     }
//     res.download(file.path, file.originalName);
//   } catch (error) {
//     console.error("Download error:", error);
//     res.status(500).json({ error: "Download failed" });
//   }
// });

// SiliconFlow API 配置
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY; // 替换为你的 API 密钥
const SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions";

// 聊天 API（支持多轮对话）
// server.js

// 聊天 API（支持多轮对话）
app.post("/chat", async (req, res) => {
  try {
    const { message, userAddress } = req.body;

    if (!userAddress) {
      return res.status(400).json({ error: "User address is required for multi-turn conversation" });
    }

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required and must be a string" });
    }

    // 获取用户的对话历史（存储在 Redis 中）
    const conversationKey = `conversation:${userAddress}`;
    let conversationHistory;
    try {
      const history = await redisClient.get(conversationKey);
      conversationHistory = history ? JSON.parse(history) : [];
    } catch (redisError) {
      console.error("Redis error:", redisError);
      return res.status(500).json({ error: "Failed to access conversation history" });
    }

    // 添加当前用户消息到对话历史
    conversationHistory.push({ role: "user", content: message });

    // 提取用户意图并查询 MongoDB
    let prompt = `You are a helpful NFT assistant. The user is having a multi-turn conversation with you. Here is the conversation history so far:\n`;

    // 添加对话历史到提示
    conversationHistory.forEach((msg) => {
      prompt += `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}\n`;
    });

    prompt += `\nBased on the conversation history, respond to the user's latest message: "${message}". Here are some possible actions:

1. If the user asks for NFTs in a specific category (e.g., "animal NFTs"), list NFTs from that category.
2. If the user asks for NFTs within a price range (e.g., "NFTs under 1 ETH"), list NFTs within that range.
3. If the user asks for their own NFTs (e.g., "my NFTs"), list NFTs owned by the user.
4. For other queries, provide a general helpful response.

Here is the relevant NFT data from the database:\n`;

    // 查询所有 NFT 数据
    let allNFTs, userNFTs, listedNFTs;
    try {
      allNFTs = await NFT.find();
      userNFTs = userAddress ? await NFT.find({ owner: userAddress }) : [];
      listedNFTs = await NFT.find({ isListed: true });
    } catch (mongoError) {
      console.error("MongoDB error:", mongoError);
      return res.status(500).json({ error: "Failed to query NFT data" });
    }

    // 将 NFT 数据添加到提示中
    prompt += `All NFTs: ${JSON.stringify(allNFTs)}\n`;
    prompt += `User's NFTs (if applicable): ${JSON.stringify(userNFTs)}\n`;
    prompt += `Listed NFTs: ${JSON.stringify(listedNFTs)}\n`;
    prompt += `Now, respond to the user's latest message: "${message}".`;

    // 调用 SiliconFlow API
    let aiReply;
    try {
      const response = await axios.post(
        SILICONFLOW_API_URL,
        {
          model: "Qwen/Qwen2.5-7B-Instruct",
          messages: [
            { role: "system", content: "You are a helpful NFT assistant." },
            { role: "user", content: prompt },
          ],
          max_tokens: 500,
          temperature: 0.7,
        },
        {
          headers: {
            Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.data || !response.data.choices || !response.data.choices[0] || !response.data.choices[0].message) {
        throw new Error("Invalid response from SiliconFlow API");
      }

      aiReply = response.data.choices[0].message.content;
    } catch (apiError) {
      console.error("SiliconFlow API error:", apiError.message);
      if (apiError.response) {
        console.error("API response:", apiError.response.data);
      }
      return res.status(500).json({ error: "Failed to get response from AI model" });
    }

    // 添加 AI 回复到对话历史
    conversationHistory.push({ role: "assistant", content: aiReply });

    // 更新 Redis 中的对话历史（设置过期时间为 1 小时）
    try {
      await redisClient.set(conversationKey, JSON.stringify(conversationHistory));
      await redisClient.expire(conversationKey, 3600);
    } catch (redisError) {
      console.error("Redis error on saving history:", redisError);
      return res.status(500).json({ error: "Failed to save conversation history" });
    }

    res.json({ reply: aiReply });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(500).json({ error: "Failed to process chat request" });
  }
});

// 保存NFT路由(添加redis缓存)
app.post("/saveNFT", async (req, res) => {
  try {
    const { tokenId, image, name, description, class: resourceClass, price, owner, uri, cid, fileCID } = req.body;
    const newNFT = new NFT({
      tokenId,
      image,
      name,
      description,
      class: resourceClass,
      price,
      owner,
      uri,
      cid,
      fileCID, // 文件的 CID
    });
    await newNFT.save();

    // 将NFT信息保存到Redis缓存中
    const nftKey = `nft:${tokenId}`;
    await redisClient.hSet(nftKey, {
      image,
      name,
      description,
      class: resourceClass,
      price,
      owner,
      uri,
      cid,
      fileCID, // 文件的 CID
    });
    await redisClient.expire(nftKey, 3600); // 设置缓存过期时间为1小时

    res.json({ message: "NFT saved successfully" });
  } catch (error) {
    console.error("Save NFT error:", error);
    res.status(500).json({ error: "Failed to save NFT" });
  }
});

// 保存多个NFT信息到数据库
app.post("/saveNFTs", async (req, res) => {
  try {
    const { nfts } = req.body;
    if (!Array.isArray(nfts)) {
      return res.status(400).json({ error: "NFTs must be an array" });
    }

    // 批量插入NFT信息
    const savedNFTs = await NFT.insertMany(nfts);
    res.json({ success: true, nfts: savedNFTs });
  } catch (error) {
    console.error("Save NFTs error:", error);
    res.status(500).json({ error: "Failed to save NFTs" });
  }
});

// 查询 NFT 信息（优先从 Redis 获取）
app.get("/nft/:tokenId", async (req, res) => {
  try {
    const tokenId = req.params.tokenId;
    const nftKey = `nft:${tokenId}`;

    // 尝试从 Redis 获取
    const cachedNFT = await redisClient.hGetAll(nftKey);
    if (Object.keys(cachedNFT).length > 0) {
      return res.json({ ...cachedNFT, tokenId });
    }

    // Redis 没有数据，从 MongoDB 获取
    const nft = await NFT.findOne({ tokenId });
    if (!nft) {
      return res.status(404).json({ error: "NFT not found" });
    }

    // 缓存到 Redis
    await redisClient.hSet(nftKey, {
      image: nft.image,
      name: nft.name,
      description: nft.description,
      class: nft.class,
      price: nft.price,
      owner: nft.owner,
      uri: nft.uri,
      cid: nft.cid,
      fileCID: nft.fileCID, // 文件的 CID
    });
    await redisClient.expire(nftKey, 3600);

    res.json(nft);
  } catch (error) {
    console.error("Get NFT error:", error);
    res.status(500).json({ error: "Failed to get NFT" });
  }
});

// 更新用户信用评分（带 Redis 缓存）
app.post("/updateCredit", async (req, res) => {
  try {
    const { userAddress, score } = req.body;
    const creditKey = `credit:${userAddress}`;

    // 更新 Redis 缓存
    await redisClient.set(creditKey, score);
    await redisClient.zAdd("credit:leaderboard", { score, value: userAddress });

    // 更新 MongoDB
    await Credit.findOneAndUpdate(
      { userAddress },
      { userAddress, score },
      { upsert: true }
    );

    res.json({ message: "Credit updated successfully" });
  } catch (error) {
    console.error("Update credit error:", error);
    res.status(500).json({ error: "Failed to update credit" });
  }
});

// 查询用户信用评分（优先从 Redis 获取）
app.get("/credit/:userAddress", async (req, res) => {
  try {
    const userAddress = req.params.userAddress;
    const creditKey = `credit:${userAddress}`;

    // 尝试从 Redis 获取
    const cachedScore = await redisClient.get(creditKey);
    if (cachedScore !== null) {
      return res.json({ userAddress, score: parseInt(cachedScore) });
    }

    // Redis 没有数据，从 MongoDB 获取
    let credit = await Credit.findOne({ userAddress });
    if (!credit) {
      credit = new Credit({ userAddress, score: 100 }); // 默认 100 分
      await credit.save();
    }

    // 缓存到 Redis
    await redisClient.set(creditKey, credit.score);
    await redisClient.zAdd("credit:leaderboard", { score: credit.score, value: userAddress });

    res.json({ userAddress, score: credit.score });
  } catch (error) {
    console.error("Get credit error:", error);
    res.status(500).json({ error: "Failed to get credit" });
  }
});

// 获取信用评分排行榜
app.get("/credit/leaderboard", async (req, res) => {
  try {
    const leaderboard = await redisClient.zRangeWithScores("credit:leaderboard", 0, -1, { REV: true });
    res.json(leaderboard);
  } catch (error) {
    console.error("Get leaderboard error:", error);
    res.status(500).json({ error: "Failed to get leaderboard" });
  }
});

// 获取用户拥有的 NFT 列表
// app.get("/nfts", async (req, res) => {
//   try {
//     const { owner } = req.query;
//     if (!owner || typeof owner !== "string") {
//       return res.status(400).json({ error: "Owner address is required" });
//     }

//     // 从 MongoDB 查询用户拥有的 NFT
//     const nfts = await NFT.find({ owner });
//     res.json(nfts);
//   } catch (error) {
//     console.error("Get NFTs error:", error);
//     res.status(500).json({ error: "Failed to get NFTs" });
//   }
// });

// 获取 NFT 列表（支持 owner 和 tokenIds 查询）
app.get("/nfts", async (req, res) => {
  try {
    const { owner, tokenIds } = req.query;

    // 查询条件
    let query = {};

    // 如果提供了 owner 参数，按 owner 查询
    if (owner) {
      if (typeof owner !== "string") {
        return res.status(400).json({ error: "Owner address must be a string" });
      }
      query.owner = owner;
    }

    // 如果提供了 tokenIds 参数，按 tokenIds 查询
    if (tokenIds) {
      if (typeof tokenIds !== "string") {
        return res.status(400).json({ error: "tokenIds must be a string (comma-separated)" });
      }
      const tokenIdArray = tokenIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
      if (tokenIdArray.length === 0) {
        return res.status(400).json({ error: "Invalid tokenIds format" });
      }
      query.tokenId = { $in: tokenIdArray }; // 使用 MongoDB 的 $in 操作符
    }

    // 如果没有提供任何参数，返回错误
    if (!owner && !tokenIds) {
      return res.status(400).json({ error: "Either owner or tokenIds is required" });
    }

    // 从 MongoDB 查询 NFT
    const nfts = await NFT.find(query);
    res.json(nfts);
  } catch (error) {
    console.error("Get NFTs error:", error);
    res.status(500).json({ error: "Failed to get NFTs" });
  }
});

// 更新 NFT 的 owner
app.post("/updateNFT", async (req, res) => {
  try {
    const { tokenId, newOwner } = req.body;
    const nft = await NFT.findOneAndUpdate(
      { tokenId },
      { owner: newOwner },
      { new: true }
    );
    if (!nft) {
      return res.status(404).json({ error: "NFT not found" });
    }

    // 更新 Redis 缓存
    const nftKey = `nft:${tokenId}`;
    await redisClient.hSet(nftKey, "owner", newOwner);
    await redisClient.expire(nftKey, 3600);

    res.json({ message: "NFT owner updated successfully" });
  } catch (error) {
    console.error("Update NFT owner error:", error);
    res.status(500).json({ error: "Failed to update NFT owner" });
  }
});

// 上架/下架 NFT
app.post("/listNFT", async (req, res) => {
  try {
    const { tokenId, price, isListed } = req.body;
    const nft = await NFT.findOne({ tokenId });
    if (!nft) {
      return res.status(404).json({ error: "NFT not found" });
    }

    // 更新 NFT 的价格和上架状态
    nft.price = isListed ? price : nft.price; // 仅在上架时更新价格
    nft.isListed = isListed; // 添加 isListed 字段（需要更新模型）
    await nft.save();

    // 更新 Redis 缓存
    const nftKey = `nft:${tokenId}`;
    await redisClient.hSet(nftKey, {
      price: nft.price,
      isListed: isListed.toString(),
    });
    await redisClient.expire(nftKey, 3600);

    res.json({ message: isListed ? "NFT listed successfully" : "NFT unlisted successfully" });
  } catch (error) {
    console.error("List NFT error:", error);
    res.status(500).json({ error: "Failed to list NFT" });
  }
});

// server.js

// 获取所有上架的 NFT
app.get("/listedNFTs", async (req, res) => {
  try {
    const listedNFTs = await NFT.find({ isListed: true });
    res.json(listedNFTs);
  } catch (error) {
    console.error("Get listed NFTs error:", error);
    res.status(500).json({ error: "Failed to get listed NFTs" });
  }
});

// 定义租赁信息 Schema
const RentalSchema = new mongoose.Schema({
  tokenId: Number,            // NFT 的唯一标识
  dailyRentPrice: String,     // 每日租金（例如 "0.1" ETH）
  maxDuration: Number,        // 最长租赁天数
  renter: String,             // 租赁者地址，初始为空
  startTime: Number,          // 租赁开始时间，初始为 0
  duration: Number,           // 租赁天数，初始为 0
  active: Boolean            // 是否处于活跃状态
});

const Rental = mongoose.model('Rental', RentalSchema);

// 创建租赁信息 API
app.post('/createRental', async (req, res) => {
  // console.log("调用该代码");
  try {
    const { tokenId, dailyRentPrice, maxDuration, renter, startTime,duration, active } = req.body;

    // 检查是否已存在活跃的租赁信息
    const existingRental = await Rental.findOne({ tokenId });
    if (existingRental && existingRental.active) {
      return res.status(400).json({ error: '该 NFT 已经出租' });
    }

    // 保存到 MongoDB
    const newRental = new Rental({
      tokenId,
      dailyRentPrice,
      maxDuration,
      renter: renter || '',
      startTime: startTime || 0,
      duration: duration || 0, // 初始化 duration
      active: active || false
    });
    console.log("newRental",newRental);
    await newRental.save();

    // 同步到 Redis
    const rentalKey = `rental:${tokenId}`;
    await redisClient.hSet(rentalKey, {
      dailyRentPrice: newRental.dailyRentPrice,
      maxDuration: newRental.maxDuration.toString(),
      renter: newRental.renter,
      startTime: newRental.startTime.toString(),
      duration: newRental.duration.toString(), // 同步 duration 到 Redis
      active: newRental.active.toString()
    });
    await redisClient.expire(rentalKey, 3600); // 设置缓存过期时间为 1 小时

    res.json({ message: '租赁信息创建成功' });
  } catch (error) {
    console.error('创建租赁信息失败:', error);
    res.status(500).json({ error: '创建租赁信息失败' });
  }
});

// 获取租赁信息 API（优先从 Redis 获取）
app.get('/getRental/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId);
    const rentalKey = `rental:${tokenId}`;

    // 尝试从 Redis 获取
    const cachedRental = await redisClient.hGetAll(rentalKey);
    if (Object.keys(cachedRental).length > 0) {
      return res.json({
        tokenId,
        dailyRentPrice: cachedRental.dailyRentPrice,
        maxDuration: parseInt(cachedRental.maxDuration),
        renter: cachedRental.renter,
        startTime: parseInt(cachedRental.startTime),
        duration: parseInt(cachedRental.duration), // 返回 duration
        active: cachedRental.active === 'true',
      });
    }

    // Redis 没有数据，从 MongoDB 获取
    const rental = await Rental.findOne({ tokenId });
    if (!rental) {
      // console.log("没有找到租赁记录")
      return res.status(404).json({ error: '租赁记录不存在' });
    }

    // 缓存到 Redis
    await redisClient.hSet(rentalKey, {
      dailyRentPrice: rental.dailyRentPrice,
      maxDuration: rental.maxDuration.toString(),
      renter: rental.renter,
      startTime: rental.startTime.toString(),
      duration: rental.duration.toString(), // 缓存 duration
      active: rental.active.toString(),
    });
    await redisClient.expire(rentalKey, 3600);

    res.json(rental);
  } catch (error) {
    console.error('获取租赁信息失败:', error);
    res.status(500).json({ error: '获取租赁信息失败' });
  }
});

// 更新租赁信息 API
app.post('/updateRental', async (req, res) => {
  try {
    const { tokenId, renter, startTime, duration, active } = req.body;

    // 检查是否存在租赁记录
    let rental = await Rental.findOne({ tokenId });
    if (!rental) {
      return res.status(404).json({ error: '租赁记录不存在' });
    }

    // 更新 MongoDB 中的租赁信息
    rental.renter = renter || rental.renter;
    rental.startTime = startTime || rental.startTime;
    rental.duration = duration !== undefined ? duration : rental.duration; // 更新 duration
    rental.active = active !== undefined ? active : rental.active;
    await rental.save();

    // 同步到 Redis
    const rentalKey = `rental:${tokenId}`;
    await redisClient.hSet(rentalKey, {
      dailyRentPrice: rental.dailyRentPrice,
      maxDuration: rental.maxDuration.toString(),
      renter: rental.renter,
      startTime: rental.startTime.toString(),
      duration: rental.duration.toString(), // 同步 duration
      active: rental.active.toString(),
    });
    await redisClient.expire(rentalKey, 3600);
    console.log("租赁信息更新成功")
    res.json({ message: '租赁信息更新成功' });
  } catch (error) {
    console.error('更新租赁信息失败:', error);
    console.log("更新租赁信息失败")
    res.status(500).json({ error: '更新租赁信息失败' });
  }
});

// 获取用户租赁的 NFT 列表
app.get("/rentedNFTs", async (req, res) => {
  // console.log("开始查询用户租赁NFT列表");
  try {
    const { renter } = req.query;
    if (!renter || typeof renter !== "string") {
      return res.status(400).json({ error: "Renter address is required" });
    }

    // 从 MongoDB 查询用户租赁的 NFT（renter 匹配且 active 为 true）
    const rentals = await Rental.find({ renter, active: true });

    // 获取租赁的 NFT 信息
    const rentedNFTs = await Promise.all(
      rentals.map(async (rental) => {
        const nft = await NFT.findOne({ tokenId: rental.tokenId });
        if (!nft) return null;
        return {
          tokenId: rental.tokenId,
          image: nft.image,
          name: nft.name,
          owner: nft.owner,
          isListed: nft.isListed,
          rentalInfo: {
            dailyRentPrice: rental.dailyRentPrice,
            maxDuration: rental.maxDuration,
            renter: rental.renter,
            startTime: rental.startTime,
            duration: rental.duration, // 包含 duration
            active: rental.active,
          },
        };
      })
    );

    // 过滤掉 null 值（NFT 不存在的情况）
    const result = rentedNFTs.filter((nft) => nft !== null);
    res.json(result);
  } catch (error) {
    console.error("Get rented NFTs error:", error);
    res.status(500).json({ error: "Failed to get rented NFTs" });
  }
});

// 归还 NFT，更新租赁信息
app.post('/endRental', async (req, res) => {
  try {
    const { tokenId } = req.body;

    // 检查是否存在租赁记录
    let rental = await Rental.findOne({ tokenId });
    if (!rental) {
      return res.status(404).json({ error: '租赁记录不存在' });
    }

    // 重置租赁信息
    rental.renter = '';
    rental.startTime = 0;
    rental.duration = 0;
    rental.active = false;
    await rental.save();

    // 同步到 Redis
    const rentalKey = `rental:${tokenId}`;
    await redisClient.hSet(rentalKey, {
      dailyRentPrice: rental.dailyRentPrice,
      maxDuration: rental.maxDuration.toString(),
      renter: rental.renter,
      startTime: rental.startTime.toString(),
      duration: rental.duration.toString(),
      active: rental.active.toString(),
    });
    await redisClient.expire(rentalKey, 3600);

    res.json({ message: '租赁信息已重置' });
  } catch (error) {
    console.error('归还 NFT 失败:', error);
    res.status(500).json({ error: '归还 NFT 失败' });
  }
});

// 定义拍卖信息模型
const AuctionSchema = new mongoose.Schema({
  tokenId: Number,
  seller: String,
  minBid: String,
  highestBid: String,
  highestBidder: String,
  endTime: Number,
  isActive: Boolean,
  image: String,
  name: String,
  description: String
});

const Auction = mongoose.model('Auction', AuctionSchema);

// 创建拍卖 API
app.post('/createAuction', async (req, res) => {
  try {
    const { tokenId, seller, minBid, endTime, image, name, description } = req.body;

    // 检查是否已存在该NFT的活跃拍卖
    const existingAuction = await Auction.findOne({ tokenId, isActive: true });
    if (existingAuction) {
      return res.status(400).json({ error: '该NFT已经在拍卖中' });
    }

    // 创建新拍卖
    const newAuction = new Auction({
      tokenId,
      seller,
      minBid,
      highestBid: "0",
      highestBidder: "",
      endTime,
      isActive: true,
      image,
      name,
      description
    });
    await newAuction.save();

    // 缓存到Redis
    const auctionKey = `auction:${tokenId}`;
    await redisClient.hSet(auctionKey, {
      seller,
      minBid,
      highestBid: "0",
      highestBidder: "",
      endTime: endTime.toString(),
      isActive: "true",
      image,
      name: name || "",
      description: description || ""
    });
    await redisClient.expire(auctionKey, 3600);

    res.json({ message: '拍卖创建成功', auction: newAuction });
  } catch (error) {
    console.error('创建拍卖失败:', error);
    res.status(500).json({ error: '创建拍卖失败' });
  }
});

// 获取拍卖列表 API
app.get('/auctions', async (req, res) => {
  try {
    const { isActive, seller, tokenId } = req.query;
    let query = {};
    
    // 根据查询参数构建查询条件
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }
    
    if (seller) {
      query.seller = seller;
    }
    
    if (tokenId) {
      query.tokenId = parseInt(tokenId);
    }
    
    const auctions = await Auction.find(query);
    res.json(auctions);
  } catch (error) {
    console.error('获取拍卖列表失败:', error);
    res.status(500).json({ error: '获取拍卖列表失败' });
  }
});

// 获取单个拍卖信息 API
app.get('/auction/:tokenId', async (req, res) => {
  try {
    const tokenId = parseInt(req.params.tokenId);
    const auctionKey = `auction:${tokenId}`;

    // 尝试从Redis获取
    const cachedAuction = await redisClient.hGetAll(auctionKey);
    if (Object.keys(cachedAuction).length > 0) {
      return res.json({
        tokenId,
        seller: cachedAuction.seller,
        minBid: cachedAuction.minBid,
        highestBid: cachedAuction.highestBid,
        highestBidder: cachedAuction.highestBidder,
        endTime: parseInt(cachedAuction.endTime),
        isActive: cachedAuction.isActive === 'true',
        image: cachedAuction.image,
        name: cachedAuction.name,
        description: cachedAuction.description
      });
    }

    // 从MongoDB获取
    const auction = await Auction.findOne({ tokenId });
    if (!auction) {
      return res.status(404).json({ error: '拍卖不存在' });
    }

    // 缓存到Redis
    await redisClient.hSet(auctionKey, {
      seller: auction.seller,
      minBid: auction.minBid,
      highestBid: auction.highestBid,
      highestBidder: auction.highestBidder,
      endTime: auction.endTime.toString(),
      isActive: auction.isActive.toString(),
      image: auction.image,
      name: auction.name || "",
      description: auction.description || ""
    });
    await redisClient.expire(auctionKey, 3600);

    res.json(auction);
  } catch (error) {
    console.error('获取拍卖信息失败:', error);
    res.status(500).json({ error: '获取拍卖信息失败' });
  }
});

// 出价 API
app.post('/placeBid', async (req, res) => {
  try {
    const { tokenId, bidder, bidAmount } = req.body;

    // 查找拍卖
    const auction = await Auction.findOne({ tokenId, isActive: true });
    if (!auction) {
      return res.status(404).json({ error: '拍卖不存在或已结束' });
    }

    // 检查出价是否有效
    if (parseFloat(bidAmount) <= parseFloat(auction.highestBid)) {
      return res.status(400).json({ error: '出价必须高于当前最高出价' });
    }
    if (parseFloat(bidAmount) < parseFloat(auction.minBid)) {
      return res.status(400).json({ error: '出价必须不低于最低出价' });
    }

    // 更新最高出价信息
    auction.highestBid = bidAmount;
    auction.highestBidder = bidder;
    await auction.save();

    // 更新Redis缓存
    const auctionKey = `auction:${tokenId}`;
    await redisClient.hSet(auctionKey, {
      highestBid: bidAmount,
      highestBidder: bidder
    });
    await redisClient.expire(auctionKey, 3600);

    res.json({ message: '出价成功', auction });
  } catch (error) {
    console.error('出价失败:', error);
    res.status(500).json({ error: '出价失败' });
  }
});

// 结束拍卖 API
app.post('/endAuction', async (req, res) => {
  try {
    const { tokenId } = req.body;

    // 查找拍卖
    const auction = await Auction.findOne({ tokenId, isActive: true });
    if (!auction) {
      return res.status(404).json({ error: '拍卖不存在或已结束' });
    }

    // 更新拍卖状态
    auction.isActive = false;
    await auction.save();

    // 如果有最高出价者，更新NFT所有者
    if (auction.highestBidder) {
      await NFT.findOneAndUpdate(
        { tokenId },
        { owner: auction.highestBidder }
      );

      // 更新NFT Redis缓存
      const nftKey = `nft:${tokenId}`;
      await redisClient.hSet(nftKey, "owner", auction.highestBidder);
      await redisClient.expire(nftKey, 3600);
    }

    // 更新拍卖Redis缓存
    const auctionKey = `auction:${tokenId}`;
    await redisClient.hSet(auctionKey, "isActive", "false");
    await redisClient.expire(auctionKey, 3600);

    res.json({ message: '拍卖已结束', auction });
  } catch (error) {
    console.error('结束拍卖失败:', error);
    res.status(500).json({ error: '结束拍卖失败' });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});