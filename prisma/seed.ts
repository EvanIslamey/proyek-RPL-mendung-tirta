import "dotenv/config";
import { PrismaClient, Role, ProductStatus } from "./generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";

// Prisma ORM v7 wajib memakai driver adapter untuk koneksi langsung ke database.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding database for Mendung Tirta...');

  // Password for all seeded users: "password123"
  const hashedPassword = await bcrypt.hash('password123', 10);

  // 1. Create Categories
  const catFishingGear = await prisma.category.upsert({
    where: { name: 'Alat Pancing' },
    update: {},
    create: {
      name: 'Alat Pancing',
      description: 'Peralatan memancing seperti joran, reel, dan kail',
    },
  });

  const catBait = await prisma.category.upsert({
    where: { name: 'Umpan' },
    update: {},
    create: {
      name: 'Umpan',
      description: 'Berbagai jenis umpan alami dan buatan',
    },
  });

  const catHarvest = await prisma.category.upsert({
    where: { name: 'Hasil Laut' },
    update: {},
    create: {
      name: 'Hasil Laut',
      description: 'Ikan segar, udang, cumi, dan hasil panen nelayan lainnya',
    },
  });

  // 2. Create Users (Admin, Seller, Buyer)
  await prisma.user.upsert({
    where: { email: 'admin@mendungtirta.com' },
    update: {},
    create: {
      name: 'Administrator',
      email: 'admin@mendungtirta.com',
      password: hashedPassword,
      role: Role.ADMIN,
      address: 'Kantor Pusat Mendung Tirta, Jakarta',
    },
  });

  const seller1 = await prisma.user.upsert({
    where: { email: 'nelayan.budi@mendungtirta.com' },
    update: {},
    create: {
      name: 'Budi Santoso',
      email: 'nelayan.budi@mendungtirta.com',
      password: hashedPassword,
      role: Role.SELLER,
      address: 'Kampung Nelayan Bahari, Blok A No. 12',
    },
  });

  const seller2 = await prisma.user.upsert({
    where: { email: 'toko.pancing.jaya@mendungtirta.com' },
    update: {},
    create: {
      name: 'Toko Pancing Jaya',
      email: 'toko.pancing.jaya@mendungtirta.com',
      password: hashedPassword,
      role: Role.SELLER,
      address: 'Jl. Raya Pesisir No. 45',
    },
  });

  await prisma.user.upsert({
    where: { email: 'pembeli@mendungtirta.com' },
    update: {},
    create: {
      name: 'Andi Kurniawan',
      email: 'pembeli@mendungtirta.com',
      password: hashedPassword,
      role: Role.BUYER,
      address: 'Perumahan Bukit Indah, Kav 8',
    },
  });

  // 3. Create Stores for Sellers
  const store1 = await prisma.store.upsert({
    where: { userId: seller1.id },
    update: {},
    create: {
      userId: seller1.id,
      storeName: 'Hasil Laut Pak Budi',
      description: 'Menjual tangkapan laut segar setiap pagi langsung dari perahu.',
      location: 'Dermaga Timur',
    },
  });

  const store2 = await prisma.store.upsert({
    where: { userId: seller2.id },
    update: {},
    create: {
      userId: seller2.id,
      storeName: 'Pancing Jaya Abadi',
      description: 'Toko perlengkapan memancing terlengkap dan termurah.',
      location: 'Pasar Pesisir',
    },
  });

  // 4. Create Products (idempoten: nama produk per toko dipakai sebagai kunci).
  //    Untuk 4 produk demo ini, stok/status dikembalikan ke kondisi awal agar
  //    seed selalu menghasilkan baseline yang sama untuk demo & pengujian.
  const productsData = [
    {
      storeId: store1.id,
      categoryId: catHarvest.id,
      name: 'Ikan Kerapu Macan Segar (1 Kg)',
      description: 'Tangkapan hari ini, sangat segar cocok untuk dibakar atau tim.',
      price: 85000,
      stock: 15,
      status: ProductStatus.AVAILABLE,
    },
    {
      storeId: store1.id,
      categoryId: catHarvest.id,
      name: 'Cumi-cumi Ring Segar (500 gr)',
      description: 'Cumi segar siap masak, sudah dibersihkan.',
      price: 45000,
      stock: 8,
      status: ProductStatus.AVAILABLE,
    },
    {
      storeId: store2.id,
      categoryId: catFishingGear.id,
      name: 'Joran Tegek Carbon 4.5m',
      description: 'Joran ringan dan kuat, cocok untuk memancing di dermaga atau karang.',
      price: 150000,
      stock: 20,
      status: ProductStatus.AVAILABLE,
    },
    {
      storeId: store2.id,
      categoryId: catBait.id,
      name: 'Umpan Minnow Lure 10cm',
      description: 'Umpan buatan (lure) sangat ampuh untuk casting ikan predator laut.',
      price: 35000,
      stock: 50,
      status: ProductStatus.AVAILABLE,
    },
  ];

  for (const p of productsData) {
    const existing = await prisma.product.findFirst({
      where: { storeId: p.storeId, name: p.name },
      select: { id: true },
    });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: { price: p.price, stock: p.stock, status: p.status },
      });
    } else {
      await prisma.product.create({ data: p });
    }
  }

  // 5. Data demo transaksi & ulasan (hanya dibuat bila belum ada satupun order,
  //    agar pengujian yang sudah berjalan tidak rusak).
  const buyer = await prisma.user.findUnique({
    where: { email: 'pembeli@mendungtirta.com' },
    select: { id: true },
  });
  const orderCount = await prisma.order.count();

  if (buyer && orderCount === 0) {
    const kerapu = await prisma.product.findFirst({
      where: { storeId: store1.id, name: productsData[0].name },
    });
    const cumi = await prisma.product.findFirst({
      where: { storeId: store1.id, name: productsData[1].name },
    });
    const joran = await prisma.product.findFirst({
      where: { storeId: store2.id, name: productsData[2].name },
    });

    const completedItems = [kerapu, joran]
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .map((p) => ({
        productId: p.id,
        quantity: 1,
        price: p.price,
      }));
    const completedTotal = completedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);

    // Order 1: sudah selesai + lunas (membuka hak memberi ulasan).
    const demoOrder = await prisma.order.create({
      data: {
        buyerId: buyer.id,
        total: completedTotal,
        status: 'COMPLETED',
        shippingAddress: 'Perumahan Bukit Indah, Kav 8',
        orderItems: { create: completedItems },
        payment: {
          create: {
            amount: completedTotal,
            method: 'dummy',
            status: 'PAID',
            paidAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
          },
        },
      },
    });

    // Ulasan demo untuk produk yang "dibeli" pada order di atas.
    if (kerapu) {
      await prisma.review.create({
        data: {
          productId: kerapu.id,
          buyerId: buyer.id,
          rating: 5,
          comment: 'Kiriman segar sekali, pakainya es batu semua. Recommended!',
        },
      });
    }
    if (joran) {
      await prisma.review.create({
        data: {
          productId: joran.id,
          buyerId: buyer.id,
          rating: 4,
          comment: 'Joran kokoh, ringan. Pengiriman sedikit lama tapi aman.',
        },
      });
    }

    // Order 2: menunggu pembayaran (tampil di dashboard & demo alur bayar).
    if (cumi) {
      await prisma.order.create({
        data: {
          buyerId: buyer.id,
          total: Number(cumi.price) * 1,
          status: 'PENDING',
          shippingAddress: 'Perumahan Bukit Indah, Kav 8',
          orderItems: {
            create: [{ productId: cumi.id, quantity: 1, price: cumi.price }],
          },
          payment: { create: { amount: Number(cumi.price) * 1, method: 'dummy', status: 'PENDING' } },
        },
      });
    }

    console.log(`Data demo transaksi dibuat (contoh order ${demoOrder.id}).`);
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
