const express = require('express');
const bodyParser = require('body-parser');
const { sequelize } = require('./model')
const { getProfile } = require('./middleware/getProfile');
const { terminedKey, defaultBestClientLimit } = require('./consts');
const { Op } = require("sequelize");

const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('models', sequelize.models)
const { Contract, Job, Profile } = sequelize.models;

async function getUnpaidJobs(userId) {
    return await Job.findAll({
        where: {
            paid: false
        },
        include: [{
            model: Contract,
            where: {
                [Op.or]: [
                    { ClientId: userId },
                    { ContractorId: userId }
                ]
            }
        }]
    });
}

app.get('/contracts/:id', getProfile, async (req, res) => {
    const { id } = req.params;
    const profileId = parseInt(req.profile.id);
    const contract = await Contract.findOne({ where: { id } })
    if (!contract)
        return res.status(404).end()
    if (contract.ClientId != profileId && contract.ContractorId != profileId)
        return res.status(401).json(`contract id ${id} does not belong to profile id ${profileId}`).end()
    res.json(contract)
});

app.get('/contracts', getProfile, async (req, res) => {
    const profileId = req.profile.id;
    const contracts = await Contract.findAll({
        where: {
            [Op.or]: [
                { ClientId: profileId },
                { ContractorId: profileId }
            ]
            , status: { [Op.ne]: [terminedKey] }
        }
    });
    if (!contracts)
        return res.status(404).end()
    res.json(contracts)
});

app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const profileId = req.profile.id;
    const unpaidJobs = await getUnpaidJobs(profileId);
    if (!unpaidJobs)
        return res.status(404).end();
    res.json(unpaidJobs);
});

app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { job_id } = req.params;
    const profileId = req.profile.id;
    const client = req.profile;

    const job = await Job.findOne({
        where: { id: job_id, paid: false },
        include: [{
            model: Contract,
            where: {
                ClientId: profileId
            }
        }]
    });

    if (!job)
        return res.status(404).end();

    if (job.price > client.balance)
        return res.status(400).json(`could not pay job id ${job_id} because job costs ${job.price} is bigger then balance ${client.balance}`).end();

    const t = await sequelize.transaction();
    try {
        await Profile.decrement({ balance: job.price }
            , { where: { id: job.Contract.ClientId } }, { transaction: t })

        await Profile.increment({ balance: job.price }
            , { where: { id: job.Contract.ContractorId } }, { transaction: t })

        await Job.update({ paid: true }
            , { where: { id: job_id } }, { transaction: t })

        await t.commit();
    }
    catch (error) {
        await t.rollback();
        return res.status(500).end();
    }
    res.status(200).end();
});

// Question - why the API containes user id? if we already requiering profile id its duplication
// Does other users can deposit to other users? it's not make a lot of sense...
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { userId } = req.params;
    const { depositAmount } = req.body;

    const client = await Profile.findOne({ where: { id: userId } });
    const unpaidJobs = await getUnpaidJobs(userId);
    const amountToPay = unpaidJobs.map(job => job.price).reduce((a, b) => a + b, 0);

    const newBalance = depositAmount + client.balance;
    if (amountToPay < newBalance * 1.25) {
        return res.status(400).json(`could not deposit because total job costs ${amountToPay} more than 125% bigger then balance ${newBalance}`).end();
    }

    await Profile.increment({ balance: depositAmount }
        , { where: { id: userId } })

    res.status(200).end();
});

app.get('/admin/best-profession', getProfile, async (req, res) => {
    const { start, end } = req.query;

    const topContractor = await Job.findOne({
        attributes: [[sequelize.fn('SUM', sequelize.col('price')), 'sold']],
        where: {
            paid: true,
            paymentDate: {
                [Op.between]: [Date.parse(start), Date.parse(end)]
            }
        },
        include: [{
            model: Contract
        }],
        group: 'contract.ContractorId',
        order: [
            [sequelize.col('sold'), 'DESC']
        ]
    });

    if (!topContractor)
        return res.status(404).end();

    res.status(200).json(topContractor).end();
});

app.get('/admin/best-clients', getProfile, async (req, res) => {
    const { start, end } = req.query;
    const limit = req.query.limit || defaultBestClientLimit;
    const topClients = await Job.findAll({
        attributes: ['contract.clientId', [sequelize.fn('SUM', sequelize.col('price')), 'paid']],
        where: {
            paid: true,
            paymentDate: {
                [Op.between]: [Date.parse(start), Date.parse(end)]
            }
        },
        include: [{
            model: Contract,
            attributes: ['clientId'],
            include: [{
                model: Profile,
                as: 'Client',
                attributes: ['firstName', 'lastname'],
            }]
        }],
        group: 'contract.clientId',
        order: [
            [sequelize.col('paid'), 'DESC']
        ],
        limit
    });

    if (!topClients)
        return res.status(404).end();

    const accessableTopClients = JSON.parse(JSON.stringify(topClients)); //HACK
    const topClientsFlatJson = accessableTopClients.map(topClient => {
        const { paid, Contract } = topClient;
        const { clientId, Client } = Contract;
        const { firstName, lastname } = Client;
        return {
            paid,
            clientId,
            fullname: `${firstName} ${lastname}`
        }
    });

    res.status(200).json(topClientsFlatJson).end();
});


module.exports = app;
