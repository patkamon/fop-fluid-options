const ethers = require("ethers");
const sfsdk = require("@superfluid-finance/sdk-core");
const EpnsAPI = require("@epnsproject/sdk-restapi");
const dotenv = require("dotenv");

dotenv.config();

const CAIP = "eip155:42:";
const channelAddress = "0x8dddb1f327113a90d6819c3a9ca574e6a81caeee";
const CallFactoryAddress = "0xca0BF23f1Ea4E08ea053691C0Dd0C066b0c31665";
const PutFactoryAddress = "0x264569c1325C26e41832dE6C8D978d59fCb05D60";
const fDAI = "0x88271d333C72e51516B67f5567c728E702b3eeE8";
const fDAIx = "0xF2d68898557cCb2Cf4C10c3Ef2B034b2a69DAD00";
const LINK = "0x326C977E6efc84E512bB9C30f76E30c160eD06FB";

const goerliTokenName = {
    "0x326C977E6efc84E512bB9C30f76E30c160eD06FB": "LINK",
    "0xF2d68898557cCb2Cf4C10c3Ef2B034b2a69DAD00": "fDAIx",
    "0x88271d333C72e51516B67f5567c728E702b3eeE8": "fDAI",
};

const goerliTokenDecimal = {
    "0x326C977E6efc84E512bB9C30f76E30c160eD06FB": 1e18,
    "0xF2d68898557cCb2Cf4C10c3Ef2B034b2a69DAD00": 1e18,
    "0x88271d333C72e51516B67f5567c728E702b3eeE8": 1e18,
};

const OptionFactory = require("../contracts/artifacts/contracts/OptionFactory.sol/OptionFactory.json");
const OptionPutFactory = require("../contracts/artifacts/contracts/OptionPutFactory.sol/OptionPutFactory.json");
const TradeableCallOption = require("../contracts/artifacts/contracts/TradeableCallOption.sol/TradeableCallOption.json");
const TradeablePutOption = require("../contracts/artifacts/contracts/TradeablePutOption.sol/TradeablePutOption.json");
const MockV3Aggregator = require("../contracts/artifacts/contracts/test/MockV3Aggregator.sol/MockV3Aggregator.json");

let subscribers = null;

async function callNotify(optionAddress) {
    // console.log("Notify Call", optionAddress);
    try {
        const provider = ethers.getDefaultProvider("goerli");
        const sf = await sfsdk.Framework.create({
            chainId: Number(5),
            provider: provider,
        });
        const contract = new ethers.Contract(
            optionAddress,
            TradeableCallOption.abi,
            provider
        );

        Promise.all([
            contract._receiver(),
            contract._underlyingAsset(),
            contract._underlyingAmount(),
            contract._dai(),
            contract._strikePrice(),
            contract._priceFeed(),
            contract._acceptedToken(),
            contract._requiredFlowRate(),
            contract._expirationDate(),
            contract.optionReady(),
            contract.optionActive(),
            contract.name(),
            contract._priceFeedDecimals(),
        ])
            .then(async (values) => {
                const optionData = {
                    address: optionAddress,
                    receiver: values[0],
                    underlyingAsset: values[1],
                    underlyingAmount: values[2],
                    purchasingAsset: values[3],
                    purchasingAmount: values[4],
                    priceFeed: values[5],
                    flowAsset: values[6],
                    requiredFlowRate: values[7],
                    expirationDate: values[8],
                    optionReady: values[9],
                    optionActive: values[10],
                    name: values[11],
                    priceFeedDecimals: values[12],
                };
                // console.log("Option Data", optionData);

                if (optionData.optionReady && optionData.optionActive) {
                    try {
                        const priceFeed = new ethers.Contract(
                            optionData.priceFeed,
                            MockV3Aggregator.abi,
                            provider
                        );

                        const currentPrice = await priceFeed.latestRoundData();
                        // console.log(currentPrice);

                        let getFlowPromises = [];
                        subscribers.forEach((subscriber) => {
                            const getFlow = async () => {
                                let flow = await sf.cfaV1.getFlow({
                                    superToken: fDAIx,
                                    sender: subscriber,
                                    receiver: optionAddress,
                                    providerOrSigner: provider,
                                });
                                return {
                                    flow: flow,
                                    subscriber: subscriber,
                                };
                            };
                            getFlowPromises.push(getFlow());
                        });
                        Promise.all(getFlowPromises)
                            .then((values) => {
                                let notifyPromises = [];
                                values.forEach((v) => {
                                    if (
                                        v.flow.deposit >=
                                            optionData.requiredFlowRate &&
                                        currentPrice[1] /
                                            10 **
                                                optionData.priceFeedDecimals >=
                                            optionData.purchasingAmount /
                                                goerliTokenDecimal[
                                                    optionData.purchasingAsset
                                                ] /
                                                (optionData.underlyingAmount /
                                                    goerliTokenDecimal[
                                                        optionData
                                                            .underlyingAsset
                                                    ])
                                    ) {
                                        const notify = async () => {
                                            const PK =
                                                process.env
                                                    .REACT_APP_EPNS_OWNER;
                                            const Pkey = `0x${PK}`;
                                            const signer = new ethers.Wallet(
                                                Pkey
                                            );
                                            const apiResponse =
                                                await EpnsAPI.payloads.sendNotification(
                                                    {
                                                        signer,
                                                        type: 3, // target
                                                        identityType: 2, // direct payload
                                                        notification: {
                                                            title: `Your call option is now exercisable!`,
                                                            body: `Your option "${
                                                                optionData.name
                                                            }" (${
                                                                optionData.address
                                                            }) is now exercisable! Check more detail at ${
                                                                "https://fop-fluid-options.herokuapp.com/call/" +
                                                                optionData.address
                                                            }`,
                                                        },
                                                        payload: {
                                                            title: `Fluid Options - Exercise Alert`,
                                                            body: `Your option is exercisable`,
                                                            cta: "",
                                                            img: "",
                                                        },
                                                        recipients:
                                                            CAIP + v.subscriber, // recipient address
                                                        channel:
                                                            CAIP +
                                                            channelAddress, // your channel address
                                                        env: "staging",
                                                    }
                                                );
                                            return apiResponse;
                                        };
                                        console.log(
                                            "Confrim Call Notify",
                                            optionAddress,
                                            v.subscriber
                                        );
                                        notifyPromises.push(notify());
                                    }
                                });
                                Promise.all(notifyPromises)
                                    .then((values) => {
                                        // console.log("Finish Notify", optionAddress, values);
                                    })
                                    .catch((err) => {});
                            })
                            .catch((err) => {});
                    } catch (err) {
                        // console.log("Error: ", err);
                    }
                }
            })
            .catch((err) => {});
    } catch (err) {
        // console.log("Error: ", err);
    }
}

async function checkCallOption() {
    const provider = ethers.getDefaultProvider("goerli");
    const contract = new ethers.Contract(
        CallFactoryAddress,
        OptionFactory.abi,
        provider
    );
    try {
        contract
            .getCallOptions()
            .then(([...data]) => {
                data.forEach((option) => {
                    callNotify(option);
                });
            })
            .catch((err) => {});
    } catch (err) {
        // console.log("Error: ", err);
    }
}

async function putNotify(optionAddress) {
    // console.log("Notify Put", optionAddress);
    try {
        const provider = ethers.getDefaultProvider("goerli");
        const sf = await sfsdk.Framework.create({
            chainId: Number(5),
            provider: provider,
        });
        const contract = new ethers.Contract(
            optionAddress,
            TradeablePutOption.abi,
            provider
        );

        Promise.all([
            contract._receiver(),
            contract._dai(),
            contract._underlyingAmount(),
            contract._purchasingAsset(),
            contract._strikePrice(),
            contract._priceFeed(),
            contract._acceptedToken(),
            contract._requiredFlowRate(),
            contract._expirationDate(),
            contract.optionReady(),
            contract.optionActive(),
            contract.name(),
            contract._priceFeedDecimals(),
        ])
            .then(async (values) => {
                const optionData = {
                    address: optionAddress,
                    receiver: values[0],
                    underlyingAsset: values[1],
                    underlyingAmount: values[2],
                    purchasingAsset: values[3],
                    purchasingAmount: values[4],
                    priceFeed: values[5],
                    flowAsset: values[6],
                    requiredFlowRate: values[7],
                    expirationDate: values[8],
                    optionReady: values[9],
                    optionActive: values[10],
                    name: values[11],
                    priceFeedDecimals: values[12],
                };
                // console.log("Option Data", optionData);

                if (optionData.optionReady && optionData.optionActive) {
                    try {
                        const priceFeed = new ethers.Contract(
                            optionData.priceFeed,
                            MockV3Aggregator.abi,
                            provider
                        );

                        const currentPrice = await priceFeed.latestRoundData();
                        // console.log(currentPrice);

                        let getFlowPromises = [];
                        subscribers.forEach((subscriber) => {
                            const getFlow = async () => {
                                let flow = await sf.cfaV1.getFlow({
                                    superToken: fDAIx,
                                    sender: subscriber,
                                    receiver: optionAddress,
                                    providerOrSigner: provider,
                                });
                                return {
                                    flow: flow,
                                    subscriber: subscriber,
                                };
                            };
                            getFlowPromises.push(getFlow());
                        });
                        Promise.all(getFlowPromises).then((values) => {
                            let notifyPromises = [];
                            values.forEach((v) => {
                                if (
                                    v.flow.deposit >=
                                        optionData.requiredFlowRate &&
                                    currentPrice[1] /
                                        10 ** optionData.priceFeedDecimals <=
                                        optionData.underlyingAmount /
                                            goerliTokenDecimal[
                                                optionData.underlyingAsset
                                            ] /
                                            (optionData.purchasingAmount /
                                                goerliTokenDecimal[
                                                    optionData.purchasingAsset
                                                ])
                                ) {
                                    const notify = async () => {
                                        const PK =
                                            process.env.REACT_APP_EPNS_OWNER;
                                        const Pkey = `0x${PK}`;
                                        const signer = new ethers.Wallet(Pkey);
                                        const apiResponse =
                                            await EpnsAPI.payloads.sendNotification(
                                                {
                                                    signer,
                                                    type: 3, // target
                                                    identityType: 2, // direct payload
                                                    notification: {
                                                        title: `Your put option is now exercisable!`,
                                                        body: `Your option "${
                                                            optionData.name
                                                        }" (${
                                                            optionData.address
                                                        }) is now exercisable! Check more detail at ${
                                                            "https://fop-fluid-options.herokuapp.com/put/" +
                                                            optionData.address
                                                        }`,
                                                    },
                                                    payload: {
                                                        title: `Fluid Options - Exercise Alert`,
                                                        body: `Your option is exercisable`,
                                                        cta: "",
                                                        img: "",
                                                    },
                                                    recipients:
                                                        CAIP + v.subscriber, // recipient address
                                                    channel:
                                                        CAIP + channelAddress, // your channel address
                                                    env: "staging",
                                                }
                                            );
                                        return apiResponse;
                                    };
                                    console.log(
                                        "Confrim Put Notify",
                                        optionAddress,
                                        v.subscriber
                                    );
                                    notifyPromises.push(notify());
                                }
                            });
                            Promise.all(notifyPromises).then((values) => {
                                // console.log("Finish Notify", optionAddress, values);
                            });
                        });
                    } catch (err) {
                        // console.log("Error: ", err);
                    }
                }
            })
            .catch((err) => {});
    } catch (err) {
        // console.log("Error: ", err);
    }
}

async function checkPutOption() {
    const provider = ethers.getDefaultProvider("goerli");
    const contract = new ethers.Contract(
        PutFactoryAddress,
        OptionPutFactory.abi,
        provider
    );
    try {
        contract
            .getPutOptions()
            .then(([...data]) => {
                data.forEach((option) => {
                    putNotify(option);
                });
            })
            .catch((err) => {});
    } catch (err) {
        // console.log("Error: ", err);
    }
}

async function getSubscriber() {
    subscribers = await EpnsAPI.channels._getSubscribers({
        channel: CAIP + channelAddress, // channel address in CAIP
        env: "staging",
    });
    subscribers = [...new Set(subscribers)];
    // console.log("subscribers", subscribers);
}

async function dailyNotify() {
    await getSubscriber();
    checkCallOption();
    checkPutOption();
}

dailyNotify();