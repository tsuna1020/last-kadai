import dotenv from 'dotenv'
import { Sequelize, DataTypes } from 'sequelize'

dotenv.config()

const dbConnectionString = process.env.DATABASE_URL || 'postgres://hellodb:myPostgres@postgres:5432/hellodb'

const sequelize = new Sequelize(dbConnectionString, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: process.env.DATABASE_URL
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : {}
})

const Messages = sequelize.define(
  'messages',
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    message: DataTypes.TEXT,
  },
  {
    freezeTableName: true,
  }
)

async function addMessage() {
  const newMessage = await Messages.create({ message: 'Hello' })
  console.log('Message saved successfully:', newMessage.dataValues)
}

async function main() {
  try {
    await sequelize.authenticate()
    console.log('Connection has been established successfully.')
    await sequelize.sync({ force: false, alter: true })
    console.log('Database synchronized successfully.')
    await addMessage()
  } catch (error) {
    console.error('Database error:', error)
  } finally {
    await sequelize.close()
  }
}

main()
